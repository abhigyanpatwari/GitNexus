/** Quote control-bearing paths for terminal output; structured results retain raw paths. */
export const formatPathForTerminal = (filePath: string): string =>
  /[\u0000-\u001f\u007f-\u009f]/.test(filePath)
    ? JSON.stringify(filePath).replace(
        /[\u007f-\u009f]/g,
        (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
      )
    : filePath;
