import {
  CreateManyDto,
  CrudRequest,
  CrudRequestOptions,
  CrudService,
  GetManyDefaultResponse,
  JoinOptions,
  QueryOptions,
} from '@nestjsx/crud';
import {
  ParsedRequestParams,
  QueryFilter,
  QueryJoin,
  QuerySort,
} from '@nestjsx/crud-request';
import {
  hasLength,
  isArrayFull,
  isObjectFull,
  isObject,
  isUndefined,
  objKeys,
} from '@nestjsx/util';
import {
  Model,
  ModelClass,
  QueryBuilder,
  Relation as ObjectionRelation,
  Transaction,
  transaction,
} from 'objection';
import { OnModuleInit } from '@nestjs/common';

interface ModelRelation {
  name: string;
  path: string;
  objectionRelation: ObjectionRelation;
  tableName: string;
  columnProps: string[];
  referencedColumnProps: string[];
}

const CHUNK_SIZE = 10000;
const OBJECTION_RELATION_SEPARATOR = ':';
const PATH_SEPARATOR = '.';

const OPERATORS: {
  [operator: string]: (
    columnProp: string,
    val?: any,
  ) => { columnProp: string; operator: string; value?: any };
} = {
  eq: (columnProp: string, val: any) => {
    return { columnProp, operator: '=', value: val };
  },
  ne: (columnProp: string, val: any) => {
    return { columnProp, operator: '!=', value: val };
  },
  gt: (columnProp: string, val: any) => {
    return { columnProp, operator: '>', value: val };
  },
  lt: (columnProp: string, val: any) => {
    return { columnProp, operator: '<', value: val };
  },
  gte: (columnProp: string, val: any) => {
    return { columnProp, operator: '>=', value: val };
  },
  lte: (columnProp: string, val: any) => {
    return { columnProp, operator: '<=', value: val };
  },
  starts: (columnProp: string, val: any) => {
    return {
      columnProp,
      operator: 'LIKE',
      value: `${val}%`,
    };
  },
  ends: (columnProp: string, val: any) => {
    return {
      columnProp,
      operator: 'LIKE',
      value: `%${val}`,
    };
  },
  cont: (columnProp: string, val: any) => {
    return {
      columnProp,
      operator: 'LIKE',
      value: `%${val}%`,
    };
  },
  excl: (columnProp: string, val: any) => {
    return {
      columnProp,
      operator: 'NOT LIKE',
      value: `%${val}%`,
    };
  },
  in: (columnProp: string, val: any) => {
    if (!isArrayFull(val)) {
      throw new Error(`Invalid column '${columnProp}' value`);
    }
    return {
      columnProp,
      operator: 'IN',
      value: val,
    };
  },
  notin: (columnProp: string, val: any) => {
    if (!isArrayFull(val)) {
      throw new Error(`Invalid column '${columnProp}' value`);
    }
    return {
      columnProp,
      operator: 'NOT IN',
      value: val,
    };
  },
  isnull: (columnProp: string) => {
    return {
      columnProp,
      operator: 'IS NULL',
    };
  },
  notnull: (columnProp: string) => {
    return {
      columnProp,
      operator: 'IS NOT NULL',
    };
  },
  between: (columnProp: string, val: any) => {
    if (!Array.isArray(val) || val.length !== 2) {
      throw new Error(`Invalid column '${columnProp}' value`);
    }

    return {
      columnProp,
      operator: 'BETWEEN',
      value: [val[0], val[1]],
    };
  },
};

export class ObjectionCrudService<T extends Model> extends CrudService<T>
  implements OnModuleInit {
  private modelColumnProps: string[];
  private modelColumnPropsSet: Set<string> = new Set();
  private modelIdColumnProps: string[];
  private modelRelations: { [relationName: string]: ModelRelation } = {};
  private notRecognizedModelRelations: Set<string> = new Set();

  constructor(public readonly modelClass: ModelClass<T>) {
    super();
  }

  async onModuleInit() {
    await this.fetchTableMetadata(this.modelClass.tableName);
    await this.initModelRelations();
    await this.initModelColumnProps();
  }

  private async fetchTableMetadata(tableName: string) {
    return Model.fetchTableMetadata({ table: tableName });
  }

  private get tableName(): string {
    return this.modelClass.tableName;
  }

  private get idColumns(): string[] {
    return [].concat(this.modelClass.idColumn);
  }

  private isIdColumnProp(columnProp: string): boolean {
    return this.modelIdColumnProps.includes(columnProp);
  }

  private columnToProp(column: string): string {
    return (Model as any).columnNameToPropertyName(column);
  }

  private getObjectionRelations<C extends Model>(
    modelClass: ModelClass<C>,
  ): { [relationName: string]: ObjectionRelation } {
    return (modelClass as any).getRelations();
  }

  public async withTransaction<R>(
    callback: (innerTrx) => Promise<R>,
    trx?: Transaction,
  ): Promise<R> {
    return transaction(trx || this.modelClass.knex(), (innerTrx) => callback(innerTrx));
  }

  /**
   * Get many
   * @param req
   * @param trx
   */
  public async getMany(
    req: CrudRequest,
    trx?: Transaction,
  ): Promise<GetManyDefaultResponse<T> | T[]> {
    const { parsed, options } = req;
    const { builder } = await this.createBuilder(parsed, options, { trx });

    const { offset, limit } = getOffsetLimit(parsed, options);
    if (Number.isFinite(offset) && Number.isFinite(limit)) {
      const { total, data } = await builder.then((data) =>
        builder.resultSize().then((total) => ({ total, data })),
      );
      return this.createPageInfo(data, total, limit, offset);
    }

    return builder;
  }

  /**
   * Get one
   * @param req
   * @param trx
   */
  public async getOne(req: CrudRequest, trx?: Transaction): Promise<T> {
    return this.getOneOrFail(req, trx);
  }

  /**
   * Create one
   * @param req
   * @param dto
   * @param trx
   */
  public async createOne(req: CrudRequest, dto: T, trx?: Transaction): Promise<T> {
    const model = this.prepareModelBeforeSave(dto, req.parsed.paramsFilter);

    if (!model) {
      this.throwBadRequestException(`Empty data. Nothing to save.`);
    }

    return this.modelClass.query(trx).insert(model);
  }

  /**
   * Create many
   * @param req
   * @param dto
   * @param trx
   */
  public async createMany(
    req: CrudRequest,
    dto: CreateManyDto<T>,
    trx?: Transaction,
  ): Promise<T[]> {
    if (!isObject(dto) || !isArrayFull(dto.bulk)) {
      this.throwBadRequestException(`Empty data. Nothing to save.`);
    }

    const bulk = dto.bulk
      .map((one) => this.prepareModelBeforeSave(one, req.parsed.paramsFilter))
      .filter((d) => !isUndefined(d));

    if (!hasLength(bulk)) {
      this.throwBadRequestException(`Empty data. Nothing to save.`);
    }

    return this.withTransaction(async (innerTrx) => {
      let result = [];

      const chunks = toChunks(bulk, CHUNK_SIZE);
      for (const chunk of chunks) {
        result = result.concat(await this.modelClass.query(innerTrx).insert(chunk));
      }

      return result;
    }, trx);
  }

  /**
   * Update one
   * @param req
   * @param dto
   * @param trx
   */
  public async updateOne(req: CrudRequest, dto: T, trx?: Transaction): Promise<T> {
    const found = await this.getOneOrFail(req, trx);

    /* istanbul ignore else */
    if (
      hasLength(req.parsed.paramsFilter) &&
      !req.options.routes.updateOneBase.allowParamsOverride
    ) {
      for (const filter of req.parsed.paramsFilter) {
        dto[filter.field] = filter.value;
      }
    }

    await found.$query(trx).patch({ ...dto });
    return found;
  }

  /**
   * Replace one
   * @param req
   * @param dto
   * @param trx
   */
  public async replaceOne(req: CrudRequest, dto: T, trx?: Transaction): Promise<T> {
    if (
      hasLength(req.parsed.paramsFilter) &&
      !req.options.routes.replaceOneBase.allowParamsOverride
    ) {
      for (const filter of req.parsed.paramsFilter) {
        dto[filter.field] = filter.value;
      }
    }

    const { condition, props } = objKeys(dto).reduce(
      (result, prop) => {
        if (this.isIdColumnProp(prop)) {
          result.condition[prop] = dto[prop];
        } else {
          result.props[prop] = dto[prop];
        }
        return result;
      },
      { condition: {}, props: {} },
    );

    if (Object.keys(condition).length === this.modelIdColumnProps.length) {
      if (!isObjectFull(props)) {
        this.throwBadRequestException('Empty data. Nothing to update.');
      }

      const updatedModel = await this.withTransaction(async (innerTrx) => {
        const model = await this.modelClass
          .query(innerTrx)
          .where(condition)
          .first()
          .limit(1)
          .forUpdate();

        if (model) {
          await model.$query(innerTrx).patch(props);
          return model;
        }
      }, trx);

      if (updatedModel) {
        return updatedModel;
      }
    }

    return this.modelClass.query(trx).insertAndFetch(props);
  }

  /**
   * Delete one
   * @param req
   * @param trx
   */
  public async deleteOne(req: CrudRequest, trx?: Transaction): Promise<void | T> {
    const found = await this.getOneOrFail(req, trx);
    await found.$query(trx).delete();

    /* istanbul ignore else */
    if (req.options.routes.deleteOneBase.returnDeleted) {
      for (const filter of req.parsed.paramsFilter) {
        found[filter.field] = filter.value;
      }

      return found;
    }
  }

  private async getOneOrFail(req: CrudRequest, trx?: Transaction): Promise<T> {
    const { parsed, options } = req;
    const { builder } = await this.createBuilder(parsed, options, { trx });
    const found = await builder.limit(1).first();

    if (!found) {
      this.throwNotFoundException(this.tableName);
    }

    return found;
  }

  private async createBuilder(
    parsedReq: ParsedRequestParams,
    options: CrudRequestOptions,
    builderOptions: {
      many?: boolean;
      trx?: Transaction;
    } = {},
  ) {
    const { many, trx } = { many: true, ...builderOptions };

    const builder = this.modelClass.query(trx).skipUndefined();
    const select = this.getSelect(parsedReq, options.query);
    builder.select(select);

    if (isArrayFull(options.query.filter)) {
      options.query.filter.forEach((filter) => {
        this.setAndWhere(filter, builder);
      });
    }

    const filters = [...parsedReq.paramsFilter, ...parsedReq.filter];
    const hasFilter = isArrayFull(filters);
    const hasOr = isArrayFull(parsedReq.or);

    if (hasFilter && hasOr) {
      if (filters.length === 1 && parsedReq.or.length === 1) {
        // WHERE :filter OR :or
        builder.andWhere((qb) => {
          this.setOrWhere(filters[0], qb);
          this.setOrWhere(parsedReq.or[0], qb);
        });
      } else if (filters.length === 1) {
        builder.andWhere((qb) => {
          this.setAndWhere(filters[0], qb);
          qb.orWhere((orQb) => {
            parsedReq.or.forEach((filter) => {
              this.setAndWhere(filter, orQb);
            });
          });
        });
      } else if (parsedReq.or.length === 1) {
        builder.andWhere((qb) => {
          this.setAndWhere(parsedReq.or[0], qb);
          qb.orWhere((orQb) => {
            filters.forEach((filter) => {
              this.setAndWhere(filter, orQb);
            });
          });
        });
      } else {
        builder.andWhere((qb) => {
          qb.andWhere((andQb) => {
            filters.forEach((filter) => {
              this.setAndWhere(filter, andQb);
            });
          });
          qb.orWhere((orQb) => {
            parsedReq.or.forEach((filter) => {
              this.setAndWhere(filter, orQb);
            });
          });
        });
      }
    } else if (hasOr) {
      // WHERE :or OR :or OR ...
      builder.andWhere((qb) => {
        parsedReq.or.forEach((filter) => {
          this.setOrWhere(filter, qb);
        });
      });
    } else if (hasFilter) {
      // WHERE :filter AND :filter AND ...
      builder.andWhere((qb) => {
        filters.forEach((filter) => {
          this.setAndWhere(filter, qb);
        });
      });
    }

    const joinOptions = options.query.join || {};
    const allowedJoins = objKeys(joinOptions);

    if (hasLength(allowedJoins)) {
      const eagerJoins: any = {};

      for (const allowedJoin of allowedJoins) {
        if (joinOptions[allowedJoin].eager) {
          const cond = parsedReq.join.find(
            (join) => join && join.field === allowedJoin,
          ) || {
            field: allowedJoin,
          };

          await this.setJoin(cond, joinOptions, builder);
          eagerJoins[allowedJoin] = true;
        }
      }

      if (isArrayFull(parsedReq.join)) {
        for (const join of parsedReq.join) {
          if (!eagerJoins[join.field]) {
            await this.setJoin(join, joinOptions, builder);
          }
        }
      }
    }

    /* istanbul ignore else */
    if (many) {
      const sort = this.getSort(parsedReq, options.query);
      sort.forEach(({ columnProp, order }) => builder.orderBy(columnProp, order));

      const { offset, limit } = getOffsetLimit(parsedReq, options);
      if (Number.isFinite(limit)) {
        builder.limit(limit);
      }

      if (Number.isFinite(offset)) {
        builder.offset(offset);
      }
    }

    if (options.query.cache && parsedReq.cache !== 0) {
      // TODO: Consider implementing this in this module
      console.warn(`Objection.js doesn't support query caching`);
    }

    return {
      builder,
    };
  }

  private async initModelColumnProps() {
    this.modelColumnProps = (await this.fetchTableMetadata(
      this.modelClass.tableName,
    )).columns.map((column) => {
      const columnProp = this.columnToProp(column);
      this.modelColumnPropsSet.add(columnProp);
      return columnProp;
    });

    this.modelIdColumnProps = this.idColumns.map((column) => this.columnToProp(column));
  }

  private prepareModelBeforeSave(dto: T, paramsFilter: QueryFilter[]): T {
    if (!isObject(dto)) {
      return undefined;
    }

    if (hasLength(paramsFilter)) {
      for (const filter of paramsFilter) {
        dto[filter.field] = filter.value;
      }
    }

    if (!hasLength(objKeys(dto))) {
      return undefined;
    }

    return dto;
  }

  private hasColumnProp(columnProp: string): boolean {
    return this.modelColumnPropsSet.has(columnProp);
  }

  private hasModelRelationColumnProp(relationPath: string, columnProp: string): boolean {
    return (
      this.hasModelRelation(relationPath) &&
      this.modelRelations[relationPath].columnProps.includes(columnProp)
    );
  }

  private getAllowedColumnProps(columnProps: string[], options: QueryOptions): string[] {
    if (!isArrayFull(options.exclude) && !isArrayFull(options.allow)) {
      return columnProps;
    }

    return columnProps.filter((columnProp) => {
      if (isArrayFull(options.exclude) && options.exclude.includes(columnProp)) {
        return false;
      }

      return isArrayFull(options.allow) ? options.allow.includes(columnProp) : true;
    });
  }

  private setAndWhere(cond: QueryFilter, builder: QueryBuilder<T>) {
    this.validateHasColumnProp(cond.field);
    const { columnProp, operator, value } = this.mapOperatorsToQuery(cond);

    if (operator === 'IS NULL') {
      builder.whereNull(columnProp);
    } else if (operator === 'IS NOT NULL') {
      builder.whereNotNull(columnProp);
    } else {
      builder.andWhere(columnProp, operator, value);
    }
  }

  private setOrWhere(cond: QueryFilter, builder: QueryBuilder<T>) {
    this.validateHasColumnProp(cond.field);
    const { columnProp, operator, value } = this.mapOperatorsToQuery(cond);

    if (operator === 'IS NULL') {
      builder.orWhereNull(columnProp);
    } else if (operator === 'IS NOT NULL') {
      builder.orWhereNotNull(columnProp);
    } else {
      builder.orWhere(columnProp, operator, value);
    }
  }

  private getSelect(query: ParsedRequestParams, options: QueryOptions): string[] {
    const allowed = this.getAllowedColumnProps(this.modelColumnProps, options);

    const columnProps = isArrayFull(query.fields)
      ? query.fields.filter((field) => allowed.includes(field))
      : allowed;

    return unique(
      [
        ...(isArrayFull(options.persist) ? options.persist : []),
        ...columnProps,
        ...this.modelIdColumnProps,
      ].map((columnProp) => this.getColumnPropWithAlias(columnProp)),
    );
  }

  private getSort(query: ParsedRequestParams, options: QueryOptions) {
    if (isArrayFull(query.sort)) {
      return this.mapSort(query.sort);
    }

    if (isArrayFull(options.sort)) {
      return this.mapSort(options.sort);
    }

    return [];
  }

  private mapSort(sort: QuerySort[]): { columnProp: string; order: string }[] {
    return sort.map(({ field, order }) => {
      this.validateHasColumnProp(field);
      return {
        columnProp: this.getColumnPropWithAlias(field),
        order,
      };
    });
  }

  private getColumnPropWithAlias(columnPropPath: string) {
    const { relations, columnProp } = splitPath(columnPropPath);
    if (!isPath(columnPropPath)) {
      return `${this.tableName}.${columnPropPath}`;
    }

    if (relations.length === 1) {
      return columnPropPath;
    }

    return `${relations.join(OBJECTION_RELATION_SEPARATOR)}.${columnProp}`;
  }

  private mapOperatorsToQuery(
    cond: QueryFilter,
  ): { columnProp: string; operator: string; value?: any } {
    try {
      const normalizedColumn = this.getColumnPropWithAlias(cond.field);
      return (OPERATORS[cond.operator] || OPERATORS.eq)(normalizedColumn, cond.value);
    } catch (e) {
      this.throwBadRequestException(e.message);
    }
  }

  private validateHasColumnProp(path: string) {
    if (isPath(path)) {
      const { relations, columnProp } = splitPath(path);

      const relationsPath = relations.join(PATH_SEPARATOR);

      if (!this.hasModelRelation(relationsPath)) {
        this.throwBadRequestException(`Invalid relation name '${relationsPath}'`);
      }

      if (!this.hasModelRelationColumnProp(relationsPath, columnProp)) {
        this.throwBadRequestException(
          `Invalid column name '${columnProp}' for relation '${relationsPath}'`,
        );
      }
    } else {
      if (!this.hasColumnProp(path)) {
        this.throwBadRequestException(`Invalid column name '${path}'`);
      }
    }
  }

  private hasModelRelation(relationPath: string): boolean {
    return !!this.modelRelations[relationPath];
  }

  private async initModelRelations() {
    const objectionRelations: ObjectionRelation[] = Object.values(
      this.getObjectionRelations(this.modelClass),
    );

    await Promise.all(
      objectionRelations.map(async (relation) => {
        this.modelRelations[relation.name] = await this.toModelRelation(relation);
      }),
    );
  }

  private async toModelRelation(
    objectionRelation: ObjectionRelation,
    overrides: Partial<ModelRelation> = {},
  ): Promise<ModelRelation> {
    const relationTableMeta = await this.fetchTableMetadata(
      objectionRelation.relatedModelClass.tableName,
    );
    return {
      name: objectionRelation.name,
      path: objectionRelation.name,
      objectionRelation,
      tableName: objectionRelation.relatedModelClass.tableName,
      columnProps: relationTableMeta.columns.map((col) => this.columnToProp(col)),
      referencedColumnProps: objectionRelation.relatedProp.props.length
        ? objectionRelation.relatedProp.props
        : objectionRelation.ownerProp.props,
      ...overrides,
    };
  }

  private getObjectionRelationByPath(relationPath: string): ObjectionRelation {
    const { relations: parentRelationNames, columnProp: targetRelationName } = splitPath(
      relationPath,
    );

    const parentRelationPath = parentRelationNames.join(PATH_SEPARATOR);
    const parentRelation = this.modelRelations[parentRelationPath];

    if (!parentRelation) {
      return null;
    }

    const parentObjectionRelations = this.getObjectionRelations(
      parentRelation.objectionRelation.ownerModelClass,
    );

    const targetObjectionRelation = parentObjectionRelations[targetRelationName];
    if (!targetObjectionRelation) {
      return null;
    }

    return targetObjectionRelation;
  }

  private async setJoin(
    cond: QueryJoin,
    joinOptions: JoinOptions,
    builder: QueryBuilder<T>,
  ) {
    if (!this.notRecognizedModelRelations.has(cond.field) && isPath(cond.field)) {
      const objectionRelation = this.getObjectionRelationByPath(cond.field);
      if (!objectionRelation) {
        this.notRecognizedModelRelations.add(cond.field);
        return;
      }

      this.modelRelations[cond.field] = await this.toModelRelation(objectionRelation, {
        path: cond.field,
      });
    }

    if (cond.field && this.hasModelRelation(cond.field) && joinOptions[cond.field]) {
      const relation = this.modelRelations[cond.field];
      const options = joinOptions[cond.field];
      const allowedColumnProps = this.getAllowedColumnProps(
        relation.columnProps,
        options,
      );

      if (!allowedColumnProps.length) {
        return;
      }

      const columnProps = isArrayFull(cond.select)
        ? cond.select.filter((col) => allowedColumnProps.includes(col))
        : allowedColumnProps;

      const select = unique([
        ...relation.referencedColumnProps,
        ...(isArrayFull(options.persist) ? options.persist : []),
        ...columnProps,
      ]);

      builder
        .mergeJoinEager(relation.path)
        .modifyEager(relation.path, (qb) => qb.select(select));
    }
  }
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function splitPath(path: string): { relations: string[]; columnProp: string } {
  const items = path.split(PATH_SEPARATOR);
  return {
    relations: items.slice(0, items.length - 1),
    columnProp: items[items.length - 1],
  };
}

function isPath(path: string) {
  return path.includes(PATH_SEPARATOR);
}

function toChunks<T>(items: T[], size = 50): T[][] {
  const chunks = [];
  let currentChunk = [];

  items.forEach((item) => {
    if (currentChunk.length > size) {
      currentChunk = [];
      chunks.push(currentChunk);
    }

    currentChunk.push(item);
  });

  if (currentChunk.length) {
    chunks.push(currentChunk);
  }

  return chunks;
}

function getOffsetLimit(
  req: ParsedRequestParams,
  options: CrudRequestOptions,
): { offset: number; limit: number } {
  const limit = getLimit(req, options.query);
  const offset = getOffset(req, limit);

  return {
    limit,
    offset,
  };
}

function getOffset(query: ParsedRequestParams, limit: number): number | null {
  if (query.page && limit) {
    return limit * (query.page - 1);
  }

  if (query.offset) {
    return query.offset;
  }

  return null;
}

function getLimit(query: ParsedRequestParams, options: QueryOptions): number | null {
  if (query.limit) {
    if (options.maxLimit) {
      if (query.limit <= options.maxLimit) {
        return query.limit;
      }
      return options.maxLimit;
    }

    return query.limit;
  }

  if (options.limit) {
    if (options.maxLimit) {
      if (options.limit <= options.maxLimit) {
        return options.limit;
      }
      return options.maxLimit;
    }

    return options.limit;
  }

  return options.maxLimit ? options.maxLimit : null;
}
