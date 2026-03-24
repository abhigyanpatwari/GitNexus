export interface ApiResponse<T> {
  data: T;
  pagination?: { page: number; total: number };
}
