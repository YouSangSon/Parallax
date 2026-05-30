export const PRODUCT_NAME = 'Parallax';
export const PACKAGE_NAME = 'parallax';

export const DATA_DIR = '.parallax';

export function envValue(name: string): string | undefined {
  return process.env[`PARALLAX_${name}`];
}
