import type { ReactNode } from 'react';

export interface DataTableColumn<Row> {
  cell(row: Row): ReactNode;
  header: string;
  hideOnMobile?: boolean;
  id: string;
  width?: string;
}

export interface DataTableProps<Row> {
  caption: string;
  columns: readonly DataTableColumn<Row>[];
  details?(row: Row): ReactNode;
  rowKey(row: Row): string;
  rows: readonly Row[];
}

export function DataTable<Row>({
  caption,
  columns,
  details,
  rowKey,
  rows
}: DataTableProps<Row>) {
  return (
    <div className="w-full overflow-x-auto">
      <table className="w-full table-fixed border-collapse text-left text-sm text-text">
        <caption className="sr-only">{caption}</caption>
        <colgroup>
          {columns.map((column) => (
            <col
              key={column.id}
              className={column.hideOnMobile ? 'hidden sm:table-column' : undefined}
              style={{ width: column.width }}
            />
          ))}
        </colgroup>
        <thead className="sr-only">
          <tr>
            {columns.map((column) => (
              <th
                key={column.id}
                scope="col"
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border/60">
          {rows.map((row) => {
            const key = rowKey(row);
            const detail = details?.(row);
            return (
              <FragmentRow
                key={key}
                columns={columns}
                detail={detail}
                row={row}
              />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function FragmentRow<Row>({
  columns,
  detail,
  row
}: {
  columns: readonly DataTableColumn<Row>[];
  detail: ReactNode;
  row: Row;
}) {
  return (
    <>
      <tr className="group/row h-10 align-middle hover:bg-control-hover/40">
        {columns.map((column) => (
          <td
            key={column.id}
            className={`${column.hideOnMobile ? 'hidden sm:table-cell ' : ''}min-w-0 px-2 py-1`}
          >
            {column.cell(row)}
          </td>
        ))}
      </tr>
      {detail ? (
        <tr>
          <td className="bg-bg-1/40 px-3 py-2" colSpan={columns.length}>{detail}</td>
        </tr>
      ) : null}
    </>
  );
}
