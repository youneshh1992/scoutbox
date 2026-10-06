/** Export only the records already supplied to the current view. */
export function csvContent(columns: string[], rows: (string | number | null | undefined)[][]) {
  const cell = (value: string | number | null | undefined) => {
    let text = value == null ? '' : String(value);
    if (/^[=+@\-\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  return '\uFEFF' + [columns, ...rows].map(row => row.map(cell).join(',')).join('\r\n');
}
export function exportCsv(filename: string, columns: string[], rows: (string | number | null | undefined)[][]) {
  const url = URL.createObjectURL(new Blob([csvContent(columns, rows)], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
