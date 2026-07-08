import { describe, expect, it } from 'vitest';
import { parseFilesWithWorkers } from '../helpers/worker-parse.js';

describe('qualified class lookups', () => {
  it('derives canonical dot-separated names from namespaces, packages, and modules', async () => {
    const { model } = await parseFilesWithWorkers([
      {
        path: 'src/Services/User.cs',
        content: 'namespace Services.Auth;\npublic class User {}\n',
      },
      {
        path: 'src/Data/User.cs',
        content: 'namespace Data.Auth;\npublic class User {}\n',
      },
      {
        path: 'src/models/Config.java',
        content: 'package com.example.models;\nclass Config {}\n',
      },
      {
        path: 'lib/admin/user.rb',
        content: 'module Admin\n  class User\n  end\nend\n',
      },
    ]);

    const userMatches = model.types.lookupClassByName('User');
    expect(userMatches).toHaveLength(3);
    expect(userMatches.map((match) => match.qualifiedName).sort()).toEqual(
      ['Admin.User', 'Data.Auth.User', 'Services.Auth.User'].sort(),
    );

    const servicesUser = model.types.lookupClassByQualifiedName('Services.Auth.User');
    expect(servicesUser).toHaveLength(1);
    expect(servicesUser[0].filePath).toBe('src/Services/User.cs');
    expect(servicesUser[0].qualifiedName).toBe('Services.Auth.User');

    const dataUser = model.types.lookupClassByQualifiedName('Data.Auth.User');
    expect(dataUser).toHaveLength(1);
    expect(dataUser[0].filePath).toBe('src/Data/User.cs');

    const javaConfig = model.types.lookupClassByQualifiedName('com.example.models.Config');
    expect(javaConfig).toHaveLength(1);
    expect(javaConfig[0].qualifiedName).toBe('com.example.models.Config');

    const rubyUser = model.types.lookupClassByQualifiedName('Admin.User');
    expect(rubyUser).toHaveLength(1);
    expect(rubyUser[0].qualifiedName).toBe('Admin.User');
  });

  it('falls back to the simple name for top-level class-like symbols', async () => {
    const { model } = await parseFilesWithWorkers([
      { path: 'src/plain-user.ts', content: 'export class User {}\n' },
    ]);

    const simpleMatches = model.types.lookupClassByName('User');
    expect(simpleMatches).toHaveLength(1);
    expect(simpleMatches[0].qualifiedName).toBe('User');

    const matches = model.types.lookupClassByQualifiedName('User');
    expect(matches).toHaveLength(1);
    expect(matches[0].qualifiedName).toBe('User');
  });
});
