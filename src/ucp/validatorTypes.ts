export interface AjvError {
  instancePath: string;
  schemaPath: string;
  keyword: string;
  message?: string;
  params?: Record<string, unknown>;
}

export interface GeneratedValidator {
  (data: unknown): boolean;
  errors?: AjvError[] | null;
}
