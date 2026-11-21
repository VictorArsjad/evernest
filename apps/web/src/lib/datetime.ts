// <input type="datetime-local"> speaks "YYYY-MM-DDTHH:mm" in LOCAL time; the
// API speaks UTC ISO strings. These three helpers are the only bridge.
const pad = (n: number) => String(n).padStart(2, "0");

function toLocalInput(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function nowLocalDatetimeInput(): string {
  return toLocalInput(new Date());
}

export function isoToLocalDatetimeInput(iso: string): string {
  return toLocalInput(new Date(iso));
}

// The browser parses "YYYY-MM-DDTHH:mm" as local; toISOString converts to UTC.
export function localToISO(local: string): string {
  return new Date(local).toISOString();
}
