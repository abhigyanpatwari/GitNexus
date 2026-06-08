export const generateId = (label: string, name: string): string => {
  return `${label}:${name}`
}

export const normalizeFilePath = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '')