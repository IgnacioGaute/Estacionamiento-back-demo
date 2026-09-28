import { BadRequestException } from '@nestjs/common';

export type ListPagination = { page: number; limit: number };
export function listPagination(page?: unknown, limit?: unknown): ListPagination {
  const read = (value: unknown, fallback: number, max: number) => {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) throw new BadRequestException('page y limit deben ser enteros positivos.');
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number > max) throw new BadRequestException(`El valor máximo permitido es ${max}.`);
    return number;
  };
  return { page: read(page, 1, 1000000), limit: read(limit, 25, 100) };
}
export function listResult<T>(data: T[], total: number, pagination: ListPagination) {
  return { data, meta: { totalItems: total, currentPage: pagination.page, itemsPerPage: pagination.limit, totalPages: Math.ceil(total / pagination.limit) } };
}
