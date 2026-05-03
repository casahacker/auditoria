import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatCurrency(value: number) {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(value);
}

export function truncateFileName(name: string, limit = 20) {
  if (name.length <= limit) return name;
  const ext = name.slice(name.lastIndexOf('.'));
  return name.slice(0, limit - ext.length) + '...' + ext;
}
