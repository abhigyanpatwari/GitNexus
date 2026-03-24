export const getQueryRows = async (result: unknown): Promise<any[]> => {
  if (!result || typeof result !== 'object') return [];

  const queryResult = result as {
    getAllObjects?: () => Promise<any[]>;
    getAllRows?: () => Promise<any[]>;
    getAll?: () => Promise<any[]>;
  };

  if (typeof queryResult.getAllObjects === 'function') {
    return await queryResult.getAllObjects();
  }
  if (typeof queryResult.getAllRows === 'function') {
    return await queryResult.getAllRows();
  }
  if (typeof queryResult.getAll === 'function') {
    return await queryResult.getAll();
  }

  throw new Error('Unsupported LadybugDB QueryResult shape');
};
