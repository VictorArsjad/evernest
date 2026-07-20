// Shared shape for the bundled WHO Child Growth Standards LMS tables.
export interface LmsRow {
  // Age in completed months (0–60).
  age: number;
  l: number; // Box-Cox power (lambda)
  m: number; // median
  s: number; // coefficient of variation
}

export interface SexTables {
  boys: LmsRow[];
  girls: LmsRow[];
}
