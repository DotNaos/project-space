export interface DatabaseQueryResult<Row> {
  rowCount?: number | null;
  rows: Row[];
}

export interface DatabaseQueryClient {
  query<Row = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[]
  ): Promise<DatabaseQueryResult<Row>>;
  transaction?<Result>(
    operation: (client: DatabaseQueryClient) => Promise<Result>
  ): Promise<Result>;
}
