import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupTempDirSync } from '../helpers/test-db.js';
import {
  assertContextFiles,
  assertSkillFiles,
  createFixtureRepo,
  runSkillsCli,
} from '../helpers/skills-e2e.js';

describe('Java', () => {
  let tmpDir: string;
  let result: ReturnType<typeof runSkillsCli>;

  beforeAll(() => {
    tmpDir = createFixtureRepo('java', {
      'src/service/UserService.java': `package service;

import repository.UserRepository;
import service.Validator;

public class UserService {
    private UserRepository repository = new UserRepository();
    private Validator validator = new Validator();

    public Object findUser(String id) {
        validator.validate(id);
        return repository.getById(id);
    }

    public Object createUser(String name) {
        validator.validate(name);
        return repository.save(name);
    }
}
`,
      'src/service/AuthService.java': `package service;

public class AuthService {
    private UserService userService = new UserService();

    public Object authenticate(String username, String password) {
        Object user = userService.findUser(username);
        return hashPassword(password);
    }

    public String hashPassword(String password) {
        return "hashed_" + password;
    }
}
`,
      'src/service/Validator.java': `package service;

public class Validator {
    public boolean validate(String input) {
        if (input == null || input.isEmpty()) {
            throw new IllegalArgumentException("Invalid input");
        }
        return true;
    }

    public String sanitize(String input) {
        return input.replaceAll("[<>]", "");
    }

    public boolean checkLength(String input, int max) {
        return input.length() <= max;
    }
}
`,
      'src/repository/UserRepository.java': `package repository;

public class UserRepository extends BaseRepository {
    public Object getById(String id) {
        return new Object();
    }

    public Object save(String name) {
        return new Object();
    }

    public boolean delete(String id) {
        return true;
    }
}
`,
      'src/repository/BaseRepository.java': `package repository;

public abstract class BaseRepository {
    public Object[] findAll() {
        return new Object[0];
    }

    public int count() {
        return 0;
    }
}
`,
      'src/model/User.java': `package model;

public class User {
    private String name;

    public User(String name) {
        this.name = name;
    }

    public String getName() {
        return name;
    }

    public void setName(String name) {
        this.name = name;
    }
}
`,
    });
    result = runSkillsCli(tmpDir);
  }, 120000);

  afterAll(() => {
    cleanupTempDirSync(tmpDir);
  });

  /**
   * Verify analyze --skills generates valid SKILL.md files for a
   * Java repo with service/repository/model clusters.
   */
  it('generates skill files', () => {
    expect(assertSkillFiles(result, tmpDir), 'Expected a Java community SKILL.md').toBe(true);
  }, 50000);

  /**
   * Verify CLAUDE.md and AGENTS.md are created and reference generated skills.
   */
  it('context files updated', () => {
    assertContextFiles(result, tmpDir);
  }, 50000);
});
