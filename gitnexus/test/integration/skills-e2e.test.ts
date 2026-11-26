/**
 * E2E Integration Tests: --skills Flag
 *
 * Tests `gitnexus analyze --skills` across the language fixtures owned by Vitest. Each language fixture creates
 * a self-contained git repo with 2 clusters of files containing cross-file
 * function calls, then runs the full CLI pipeline and verifies SKILL.md
 * generation and context file updates.
 *
 * Uses process.execPath (never 'node' string), no shell: true.
 */
import { describe, it, beforeAll, afterAll } from 'vitest';
import { cleanupTempDirSync } from '../helpers/test-db.js';

import {
  assertContextFiles,
  assertSkillFiles,
  createFixtureRepo,
  runSkillsCli,
} from '../helpers/skills-e2e.js';

// ============================================================================
// DESCRIBE 2: JavaScript
// ============================================================================

describe('JavaScript', () => {
  let tmpDir: string;
  let result: ReturnType<typeof runSkillsCli>;

  beforeAll(() => {
    tmpDir = createFixtureRepo('javascript', {
      'src/handlers/userHandler.js': `
const { findById } = require('../services/userService');
const { validateInput } = require('../helpers/validator');

function getUser(id) {
  validateInput(id);
  return findById(id);
}

function createUser(data) {
  validateInput(data.name);
  return { id: Date.now(), ...data };
}

module.exports = { getUser, createUser };
`,
      'src/handlers/authHandler.js': `
const { hashPassword, createToken } = require('../services/authService');

function login(username, password) {
  const hashed = hashPassword(password);
  return createToken(username);
}

function logout(token) {
  return { success: true };
}

module.exports = { login, logout };
`,
      'src/handlers/errorHandler.js': `
const { logError } = require('../helpers/logger');

function handleError(err) {
  logError(err.message);
  return { error: err.message };
}

function formatError(err) {
  logError('format: ' + err.message);
  return { code: err.code || 500, message: err.message };
}

module.exports = { handleError, formatError };
`,
      'src/services/userService.js': `
const { formatUser } = require('./formatService');

function findById(id) {
  const user = { id, name: 'Test' };
  return formatUser(user);
}

function saveUser(user) {
  return { ...user, saved: true };
}

module.exports = { findById, saveUser };
`,
      'src/services/authService.js': `
function hashPassword(password) {
  return 'hashed_' + password;
}

function createToken(username) {
  return 'token_' + username + '_' + Date.now();
}

function verifyToken(token) {
  return token.startsWith('token_');
}

module.exports = { hashPassword, createToken, verifyToken };
`,
      'src/services/formatService.js': `
function formatUser(user) {
  return { ...user, displayName: user.name.toUpperCase() };
}

function formatDate(date) {
  return new Date(date).toISOString();
}

function formatError(err) {
  return { error: true, message: String(err) };
}

module.exports = { formatUser, formatDate, formatError };
`,
      'src/helpers/validator.js': `
function validateInput(input) {
  if (!input) throw new Error('Required');
  return true;
}

function validateEmail(email) {
  return /^[^@]+@[^@]+$/.test(email);
}

function sanitize(str) {
  return String(str).replace(/[<>]/g, '');
}

module.exports = { validateInput, validateEmail, sanitize };
`,
      'src/helpers/logger.js': `
function logError(msg) {
  console.error('[ERROR]', msg);
}

function logInfo(msg) {
  console.log('[INFO]', msg);
}

function createEntry(level, msg) {
  return { level, msg, ts: Date.now() };
}

module.exports = { logError, logInfo, createEntry };
`,
    });
    result = runSkillsCli(tmpDir);
  }, 120000);

  afterAll(() => {
    cleanupTempDirSync(tmpDir);
  });

  /**
   * Verify analyze --skills generates valid SKILL.md files for a
   * JavaScript repo with handler/service/helper clusters.
   */
  it('generates skill files', () => {
    assertSkillFiles(result, tmpDir);
  }, 50000);

  /**
   * Verify CLAUDE.md and AGENTS.md are created and reference generated skills.
   */
  it('context files updated', () => {
    assertContextFiles(result, tmpDir);
  }, 50000);
});

// ============================================================================
// DESCRIBE 3: Python
// ============================================================================

describe('Python', () => {
  let tmpDir: string;
  let result: ReturnType<typeof runSkillsCli>;

  beforeAll(() => {
    tmpDir = createFixtureRepo('python', {
      'src/auth/__init__.py': '',
      'src/auth/login.py': `
from src.auth.hash import hash_password
from src.auth.session import create_session

def login(username, password):
    hashed = hash_password(password)
    session = create_session(username)
    return session

def validate_credentials(username, password):
    if not username or not password:
        raise ValueError("Invalid credentials")
    return True
`,
      'src/auth/hash.py': `
def hash_password(password):
    return "hashed_" + password

def compare_hash(plain, hashed):
    return hash_password(plain) == hashed

def generate_salt():
    return "salt_" + str(id(object()))
`,
      'src/auth/session.py': `
from src.auth.login import login

def create_session(username):
    return {"user": username, "token": "sess_" + username}

def validate_session(session):
    return session and "token" in session

def refresh_session(session):
    return create_session(session["user"])
`,
      'src/database/__init__.py': '',
      'src/database/query.py': `
from src.database.format import format_result
from src.database.cache import get_cached

def run_query(sql):
    cached = get_cached(sql)
    if cached:
        return cached
    return format_result({"sql": sql, "rows": []})

def build_query(table, conditions):
    return f"SELECT * FROM {table}"
`,
      'src/database/format.py': `
def format_result(data):
    return {**data, "formatted": True}

def serialize_result(data):
    import json
    return json.dumps(data)

def format_error(err):
    return {"error": str(err)}
`,
      'src/database/cache.py': `
from src.database.query import run_query

_cache = {}

def get_cached(key):
    return _cache.get(key)

def warm_cache(keys):
    for key in keys:
        _cache[key] = run_query(key)
`,
      'src/utils/__init__.py': '',
      'src/utils/logger.py': `
def log_info(msg):
    print(f"[INFO] {msg}")

def log_error(msg):
    print(f"[ERROR] {msg}")

def create_entry(level, msg):
    return {"level": level, "msg": msg}
`,
      'src/utils/validator.py': `
def validate_input(data):
    if not data:
        raise ValueError("Input required")
    return True

def sanitize(text):
    return text.replace("<", "").replace(">", "")

def check_length(text, max_len=255):
    return len(text) <= max_len
`,
    });
    result = runSkillsCli(tmpDir);
  }, 120000);

  afterAll(() => {
    cleanupTempDirSync(tmpDir);
  });

  /**
   * Verify analyze --skills generates valid SKILL.md files for a
   * Python repo with auth/database/utils clusters.
   */
  it('generates skill files', () => {
    assertSkillFiles(result, tmpDir);
  }, 50000);

  /**
   * Verify CLAUDE.md and AGENTS.md are created and reference generated skills.
   */
  it('context files updated', () => {
    assertContextFiles(result, tmpDir);
  }, 50000);
});

// ============================================================================
// DESCRIBE 4: Go
// ============================================================================

describe('Go', () => {
  let tmpDir: string;
  let result: ReturnType<typeof runSkillsCli>;

  beforeAll(() => {
    tmpDir = createFixtureRepo('go', {
      'go.mod': `module example.com/testapp

go 1.21
`,
      'cmd/main.go': `package main

import (
	"example.com/testapp/pkg/handler"
)

func main() {
	handler.HandleGet("1")
	handler.HandlePost(map[string]string{"name": "test"})
}
`,
      'pkg/handler/get.go': `package handler

import (
	"example.com/testapp/pkg/service"
)

func HandleGet(id string) map[string]interface{} {
	user := service.FindUser(id)
	return service.FormatResponse(user)
}
`,
      'pkg/handler/post.go': `package handler

import (
	"example.com/testapp/pkg/service"
)

func HandlePost(data map[string]string) map[string]interface{} {
	service.ValidateInput(data)
	return service.CreateUser(data)
}
`,
      'pkg/service/user.go': `package service

import (
	"example.com/testapp/pkg/repository"
)

func FindUser(id string) map[string]interface{} {
	return repository.GetByID(id)
}

func CreateUser(data map[string]string) map[string]interface{} {
	repository.Save(data)
	return map[string]interface{}{"created": true}
}
`,
      'pkg/service/format.go': `package service

func FormatResponse(data map[string]interface{}) map[string]interface{} {
	data["formatted"] = true
	return data
}

func ValidateInput(data map[string]string) bool {
	return len(data) > 0
}

func Sanitize(input string) string {
	return input
}
`,
      'pkg/repository/user_repo.go': `package repository

func GetByID(id string) map[string]interface{} {
	return map[string]interface{}{"id": id, "name": "Test"}
}

func Save(data map[string]string) bool {
	return true
}

func Delete(id string) bool {
	return true
}
`,
      'pkg/models/user.go': `package models

type User struct {
	ID   string
	Name string
}

func NewUser(id, name string) *User {
	return &User{ID: id, Name: name}
}

func (u *User) Validate() bool {
	return u.ID != "" && u.Name != ""
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
   * Go repo with handler/service/repository clusters.
   */
  it('generates skill files', () => {
    assertSkillFiles(result, tmpDir);
  }, 50000);

  /**
   * Verify CLAUDE.md and AGENTS.md are created and reference generated skills.
   */
  it('context files updated', () => {
    assertContextFiles(result, tmpDir);
  }, 50000);
});

// ============================================================================
// DESCRIBE 6: Rust
// ============================================================================

describe('Rust', () => {
  let tmpDir: string;
  let result: ReturnType<typeof runSkillsCli>;

  beforeAll(() => {
    tmpDir = createFixtureRepo('rust', {
      'Cargo.toml': `[package]
name = "testapp"
version = "0.1.0"
edition = "2021"
`,
      'src/main.rs': `mod auth;
mod data;

fn main() {
    let session = auth::login::login("user", "pass");
    let result = data::query::run_query("SELECT 1");
    println!("{:?} {:?}", session, result);
}
`,
      'src/auth/mod.rs': `pub mod login;
pub mod hash;
`,
      'src/auth/login.rs': `use crate::auth::hash::hash_password;

pub fn login(username: &str, password: &str) -> String {
    let hashed = hash_password(password);
    format!("session_{}_{}", username, hashed)
}

pub fn validate(token: &str) -> bool {
    token.starts_with("session_")
}
`,
      'src/auth/hash.rs': `pub fn hash_password(password: &str) -> String {
    format!("hashed_{}", password)
}

pub fn compare_hash(plain: &str, hashed: &str) -> bool {
    hash_password(plain) == hashed
}

pub fn generate_salt() -> String {
    String::from("random_salt")
}
`,
      'src/data/mod.rs': `pub mod query;
pub mod format;
`,
      'src/data/query.rs': `use crate::data::format::format_result;

pub fn run_query(sql: &str) -> String {
    let raw = format!("result_{}", sql);
    format_result(&raw)
}

pub fn build_query(table: &str) -> String {
    format!("SELECT * FROM {}", table)
}
`,
      'src/data/format.rs': `pub fn format_result(data: &str) -> String {
    format!("[formatted] {}", data)
}

pub fn serialize(data: &str) -> String {
    format!("{{\"data\": \"{}\"}}", data)
}

pub fn format_error(err: &str) -> String {
    format!("[ERROR] {}", err)
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
   * Rust repo with auth/data module clusters.
   */
  it('generates skill files', () => {
    assertSkillFiles(result, tmpDir);
  }, 50000);

  /**
   * Verify CLAUDE.md and AGENTS.md are created and reference generated skills.
   */
  it('context files updated', () => {
    assertContextFiles(result, tmpDir);
  }, 50000);
});

// ============================================================================
// DESCRIBE 7: C#
// ============================================================================

describe('CSharp', () => {
  let tmpDir: string;
  let result: ReturnType<typeof runSkillsCli>;

  beforeAll(() => {
    tmpDir = createFixtureRepo('csharp', {
      'Services/UserService.cs': `using System;

namespace Services
{
    public class UserService
    {
        public object FindUser(string id)
        {
            return id;
        }

        public object CreateUser(string name)
        {
            return name;
        }

        public object UpdateUser(string id, string name)
        {
            return name;
        }

        public bool RemoveUser(string id)
        {
            return true;
        }
    }

    public class UserValidator
    {
        public bool ValidateUser(string input)
        {
            return true;
        }

        public string SanitizeUser(string input)
        {
            return input;
        }

        public bool CheckUserLength(string input)
        {
            return true;
        }
    }
}
`,
      'Services/AuthService.cs': `using System;

namespace Services
{
    public class AuthService
    {
        public object Authenticate(string username, string password)
        {
            return username;
        }

        public string HashPassword(string password)
        {
            return password;
        }

        public bool VerifyPassword(string hashed)
        {
            return true;
        }

        public string CreateToken(string username)
        {
            return username;
        }
    }

    public class TokenManager
    {
        public string GenerateToken(string user)
        {
            return user;
        }

        public bool ValidateToken(string token)
        {
            return true;
        }

        public string RefreshToken(string token)
        {
            return token;
        }
    }
}
`,
      'Services/OrderService.cs': `using System;

namespace Services
{
    public class OrderService
    {
        public object CreateOrder(string item)
        {
            return item;
        }

        public object GetOrder(string id)
        {
            return id;
        }

        public bool CancelOrder(string id)
        {
            return true;
        }

        public object UpdateOrder(string id, string item)
        {
            return item;
        }
    }

    public class OrderValidator
    {
        public bool ValidateOrder(string input)
        {
            return true;
        }

        public string SanitizeOrder(string input)
        {
            return input;
        }
    }
}
`,
      'Services/EmailService.cs': `using System;

namespace Services
{
    public class EmailService
    {
        public void SendMail(string to, string body)
        {
        }

        public void SendBulk(string to, string body)
        {
        }

        public string FormatBody(string body)
        {
            return body;
        }

        public bool ValidateAddress(string addr)
        {
            return true;
        }
    }
}
`,
      'Data/UserRepo.cs': `using System;

namespace Data
{
    public class UserRepo
    {
        public object GetById(string id)
        {
            return id;
        }

        public object Save(string name)
        {
            return name;
        }

        public object Update(string id, string name)
        {
            return name;
        }

        public bool Delete(string id)
        {
            return true;
        }

        public object[] ListAll()
        {
            return new object[0];
        }
    }
}
`,
      'Data/OrderRepo.cs': `using System;

namespace Data
{
    public class OrderRepo
    {
        public object FindOrder(string id)
        {
            return id;
        }

        public object InsertOrder(string item)
        {
            return item;
        }

        public bool RemoveOrder(string id)
        {
            return true;
        }

        public object UpdateOrder(string id, string data)
        {
            return data;
        }

        public int CountOrders()
        {
            return 0;
        }
    }
}
`,
      'Data/CacheManager.cs': `using System;

namespace Data
{
    public class CacheManager
    {
        public object GetCached(string key)
        {
            return key;
        }

        public void SetCached(string key, object val)
        {
        }

        public void Invalidate(string key)
        {
        }

        public void Clear()
        {
        }
    }

    public class CacheStats
    {
        public int GetHitCount()
        {
            return 0;
        }

        public int GetMissCount()
        {
            return 0;
        }

        public double GetHitRate()
        {
            return 0.0;
        }
    }
}
`,
      'Data/Logger.cs': `using System;

namespace Data
{
    public class Logger
    {
        public void Info(string msg)
        {
        }

        public void Error(string msg)
        {
        }

        public void Warn(string msg)
        {
        }

        public void Debug(string msg)
        {
        }
    }

    public class LogFormatter
    {
        public string FormatEntry(string level, string msg)
        {
            return level + msg;
        }

        public string FormatTimestamp()
        {
            return "";
        }

        public string FormatStackTrace(string trace)
        {
            return trace;
        }
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
   * C# repo with Services/Data clusters.
   *
   * Note: tree-sitter-c-sharp's native N-API addon can crash in forked
   * workers on some platforms (libc++abi exception). When this happens,
   * the pipeline falls through with 0 communities and no skills are
   * generated. assertSkillFiles handles this gracefully.
   */
  it('generates skill files', () => {
    assertSkillFiles(result, tmpDir);
  }, 50000);

  /**
   * Verify CLAUDE.md and AGENTS.md are created and reference generated skills.
   */
  it('context files updated', () => {
    assertContextFiles(result, tmpDir);
  }, 50000);
});

// ============================================================================
// DESCRIBE 8: C++
// ============================================================================

describe('CPlusPlus', () => {
  let tmpDir: string;
  let result: ReturnType<typeof runSkillsCli>;

  beforeAll(() => {
    tmpDir = createFixtureRepo('cpp', {
      'src/engine/engine.h': `#ifndef ENGINE_H
#define ENGINE_H

class Engine {
public:
    void start();
    void stop();
};

#endif
`,
      'src/engine/engine.cpp': `#include "engine.h"
#include "../utils/logger.h"
#include "../utils/config.h"

void Engine::start() {
    Logger logger;
    logger.log("Engine starting");
    Config config;
    config.get("engine.mode");
}

void Engine::stop() {
    Logger logger;
    logger.log("Engine stopping");
}
`,
      'src/engine/renderer.h': `#ifndef RENDERER_H
#define RENDERER_H

class Renderer {
public:
    void render();
    void clear();
};

#endif
`,
      'src/engine/renderer.cpp': `#include "renderer.h"
#include "engine.h"

void Renderer::render() {
    Engine engine;
    engine.start();
}

void Renderer::clear() {
}
`,
      'src/engine/physics.h': `#ifndef PHYSICS_H
#define PHYSICS_H

void simulate();
void collide();

#endif
`,
      'src/engine/physics.cpp': `#include "physics.h"
#include "engine.h"
#include "../utils/logger.h"

void simulate() {
    Engine engine;
    engine.stop();
    Logger logger;
    logger.log("simulating");
}

void collide() {
    Logger logger;
    logger.log("collision detected");
}
`,
      'src/utils/logger.h': `#ifndef LOGGER_H
#define LOGGER_H

#include <string>

class Logger {
public:
    void log(const std::string& msg);
    void error(const std::string& msg);
    void flush();
};

#endif
`,
      'src/utils/logger.cpp': `#include "logger.h"
#include <iostream>

void Logger::log(const std::string& msg) {
    std::cout << "[LOG] " << msg << std::endl;
}

void Logger::error(const std::string& msg) {
    std::cerr << "[ERR] " << msg << std::endl;
}

void Logger::flush() {
    std::cout.flush();
}
`,
      'src/utils/config.h': `#ifndef CONFIG_H
#define CONFIG_H

#include <string>

class Config {
public:
    std::string get(const std::string& key);
    void set(const std::string& key, const std::string& value);
    void load(const std::string& path);
};

#endif
`,
      'src/utils/config.cpp': `#include "config.h"

std::string Config::get(const std::string& key) {
    return "";
}

void Config::set(const std::string& key, const std::string& value) {
}

void Config::load(const std::string& path) {
}
`,
      'src/utils/math.h': `#ifndef MATH_H
#define MATH_H

int clamp(int value, int min, int max);
float lerp(float a, float b, float t);
double distance(double x1, double y1, double x2, double y2);

#endif
`,
      'src/utils/math.cpp': `#include "math.h"
#include <cmath>

int clamp(int value, int min, int max) {
    if (value < min) return min;
    if (value > max) return max;
    return value;
}

float lerp(float a, float b, float t) {
    return a + (b - a) * t;
}

double distance(double x1, double y1, double x2, double y2) {
    return std::sqrt((x2-x1)*(x2-x1) + (y2-y1)*(y2-y1));
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
   * C++ repo with engine/utils clusters including headers.
   */
  it('generates skill files', () => {
    assertSkillFiles(result, tmpDir);
  }, 50000);

  /**
   * Verify CLAUDE.md and AGENTS.md are created and reference generated skills.
   */
  it('context files updated', () => {
    assertContextFiles(result, tmpDir);
  }, 50000);
});

// ============================================================================
// DESCRIBE 9: C
// ============================================================================

describe('C', () => {
  let tmpDir: string;
  let result: ReturnType<typeof runSkillsCli>;

  beforeAll(() => {
    tmpDir = createFixtureRepo('c', {
      'src/core/parser.h': `#ifndef PARSER_H
#define PARSER_H

void parse(const char* input);
void tokenize(const char* input);

#endif
`,
      'src/core/parser.c': `#include "parser.h"
#include "../io/reader.h"
#include "../io/logger.h"

void parse(const char* input) {
    char* data = read_file(input);
    log_msg("parsing");
    tokenize(data);
}

void tokenize(const char* input) {
    log_msg("tokenizing");
}
`,
      'src/core/lexer.h': `#ifndef LEXER_H
#define LEXER_H

typedef struct {
    int type;
    const char* value;
} Token;

void lex(const char* input);
Token next_token(const char* input);
int is_keyword(const char* word);

#endif
`,
      'src/core/lexer.c': `#include "lexer.h"
#include "parser.h"
#include <string.h>

void lex(const char* input) {
    parse(input);
}

Token next_token(const char* input) {
    Token t;
    t.type = 0;
    t.value = input;
    return t;
}

int is_keyword(const char* word) {
    return strcmp(word, "if") == 0 || strcmp(word, "else") == 0;
}
`,
      'src/core/ast.h': `#ifndef AST_H
#define AST_H

typedef struct ASTNode {
    int type;
    struct ASTNode* left;
    struct ASTNode* right;
} ASTNode;

ASTNode* create_node(int type);
void free_node(ASTNode* node);

#endif
`,
      'src/core/ast.c': `#include "ast.h"
#include "lexer.h"
#include <stdlib.h>

ASTNode* create_node(int type) {
    ASTNode* node = (ASTNode*)malloc(sizeof(ASTNode));
    node->type = type;
    node->left = NULL;
    node->right = NULL;
    tokenize("ast");
    return node;
}

void free_node(ASTNode* node) {
    if (node) {
        free_node(node->left);
        free_node(node->right);
        free(node);
    }
}
`,
      'src/io/reader.h': `#ifndef READER_H
#define READER_H

char* read_file(const char* path);
void close_file(const char* path);
int file_exists(const char* path);

#endif
`,
      'src/io/reader.c': `#include "reader.h"
#include <stdio.h>
#include <stdlib.h>

char* read_file(const char* path) {
    return "file contents";
}

void close_file(const char* path) {
}

int file_exists(const char* path) {
    FILE* f = fopen(path, "r");
    if (f) { fclose(f); return 1; }
    return 0;
}
`,
      'src/io/writer.h': `#ifndef WRITER_H
#define WRITER_H

void write_file(const char* path, const char* data);
void flush_writer(void);

#endif
`,
      'src/io/writer.c': `#include "writer.h"
#include "logger.h"

void write_file(const char* path, const char* data) {
    log_msg("writing file");
}

void flush_writer(void) {
    log_msg("flushing");
}
`,
      'src/io/logger.h': `#ifndef LOGGER_H
#define LOGGER_H

void log_msg(const char* msg);
void log_error(const char* msg);
void log_init(void);

#endif
`,
      'src/io/logger.c': `#include "logger.h"
#include <stdio.h>

void log_msg(const char* msg) {
    printf("[LOG] %s\\n", msg);
}

void log_error(const char* msg) {
    fprintf(stderr, "[ERR] %s\\n", msg);
}

void log_init(void) {
    log_msg("logger initialized");
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
   * C repo with core/io clusters including headers.
   */
  it('generates skill files', () => {
    assertSkillFiles(result, tmpDir);
  }, 50000);

  /**
   * Verify CLAUDE.md and AGENTS.md are created and reference generated skills.
   */
  it('context files updated', () => {
    assertContextFiles(result, tmpDir);
  }, 50000);
});

// ============================================================================
// DESCRIBE 10: PHP
// ============================================================================

describe('PHP', () => {
  let tmpDir: string;
  let result: ReturnType<typeof runSkillsCli>;

  beforeAll(() => {
    tmpDir = createFixtureRepo('php', {
      'src/Controllers/UserController.php': `<?php

function controller_index() {
    validate_input('list');
    $users = service_find_all();
    return format_response($users);
}

function controller_store($data) {
    validate_input($data);
    sanitize_input($data);
    $user = service_find_by_id($data);
    return format_response($user);
}

function controller_update($id, $data) {
    validate_input($id);
    validate_input($data);
    $result = service_update($id, $data);
    return format_response($result);
}

function controller_delete($id) {
    validate_input($id);
    return service_delete($id);
}
`,
      'src/Controllers/AuthController.php': `<?php

function auth_login($username, $password) {
    validate_input($username);
    validate_input($password);
    $hash = auth_hash_password($password);
    return auth_create_token($username);
}

function auth_logout($token) {
    validate_input($token);
    return true;
}

function auth_register($username, $password) {
    validate_input($username);
    sanitize_input($username);
    $hash = auth_hash_password($password);
    return service_create($username, $hash);
}
`,
      'src/Controllers/ApiController.php': `<?php

function api_handle_request($method, $path) {
    validate_input($method);
    validate_input($path);
    log_request($method . ' ' . $path);
    return format_response(['method' => $method, 'path' => $path]);
}

function api_handle_error($error) {
    log_error($error);
    return format_error($error);
}

function api_middleware($request) {
    validate_input($request);
    log_request('middleware');
    return true;
}
`,
      'src/Services/UserService.php': `<?php

function service_find_all() {
    $result = db_query('SELECT * FROM users');
    return format_response($result);
}

function service_find_by_id($id) {
    $result = db_query('SELECT * FROM users WHERE id = ' . $id);
    return format_response($result);
}

function service_create($name, $hash) {
    db_execute('INSERT INTO users VALUES (' . $name . ')');
    log_request('user created');
    return true;
}

function service_update($id, $data) {
    db_execute('UPDATE users SET data = ' . $data);
    log_request('user updated');
    return true;
}

function service_delete($id) {
    db_execute('DELETE FROM users WHERE id = ' . $id);
    log_request('user deleted');
    return true;
}
`,
      'src/Services/AuthServiceImpl.php': `<?php

function auth_hash_password($password) {
    validate_input($password);
    return 'hashed_' . $password;
}

function auth_create_token($username) {
    validate_input($username);
    log_request('token created for ' . $username);
    return 'token_' . $username;
}

function auth_verify_token($token) {
    validate_input($token);
    return strpos($token, 'token_') === 0;
}

function auth_refresh_token($token) {
    auth_verify_token($token);
    return auth_create_token('refreshed');
}
`,
      'src/Helpers/validator.php': `<?php

function validate_input($input) {
    if (empty($input)) {
        throw new InvalidArgumentException('Invalid');
    }
    return true;
}

function sanitize_input($input) {
    return htmlspecialchars($input);
}

function check_required($data, $fields) {
    foreach ($fields as $field) {
        if (!isset($data[$field])) return false;
    }
    return true;
}

function check_length($input, $max = 255) {
    return strlen($input) <= $max;
}
`,
      'src/Helpers/logger.php': `<?php

function log_request($msg) {
    echo '[REQ] ' . $msg . "\\n";
}

function log_error($msg) {
    echo '[ERR] ' . $msg . "\\n";
}

function log_info($msg) {
    echo '[INFO] ' . $msg . "\\n";
}

function create_log_entry($level, $msg) {
    return ['level' => $level, 'msg' => $msg, 'ts' => time()];
}
`,
      'src/Helpers/formatter.php': `<?php

function format_response($data) {
    return ['status' => 200, 'body' => $data, 'formatted' => true];
}

function format_error($err) {
    return ['status' => 500, 'error' => $err];
}

function format_date($timestamp) {
    return date('Y-m-d', $timestamp);
}

function format_json($data) {
    return json_encode($data);
}
`,
      'src/Data/database.php': `<?php

function db_query($sql) {
    log_request('query: ' . $sql);
    return [];
}

function db_execute($sql) {
    log_request('execute: ' . $sql);
    return true;
}

function db_connect($host) {
    return true;
}

function db_close() {
    return true;
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
   * PHP repo with Controllers/Services/Models clusters.
   */
  it('generates skill files', () => {
    assertSkillFiles(result, tmpDir);
  }, 50000);

  /**
   * Verify CLAUDE.md and AGENTS.md are created and reference generated skills.
   */
  it('context files updated', () => {
    assertContextFiles(result, tmpDir);
  }, 50000);
});

// ============================================================================
// DESCRIBE 11: Kotlin
// ============================================================================

describe('Kotlin', () => {
  let tmpDir: string;
  let result: ReturnType<typeof runSkillsCli>;

  beforeAll(() => {
    tmpDir = createFixtureRepo('kotlin', {
      'src/main/kotlin/service/UserService.kt': `package service

fun findUser(id: String): Map<String, Any> {
    validateInput(id)
    val result = dbQuery("SELECT * FROM users WHERE id = $id")
    return formatResponse(result)
}

fun createUser(name: String): Map<String, Any> {
    validateInput(name)
    sanitizeInput(name)
    dbExecute("INSERT INTO users VALUES ('$name')")
    logRequest("user created")
    return formatResponse(mapOf("name" to name))
}

fun updateUser(id: String, name: String): Map<String, Any> {
    validateInput(id)
    validateInput(name)
    dbExecute("UPDATE users SET name = '$name' WHERE id = $id")
    logRequest("user updated")
    return formatResponse(mapOf("id" to id))
}

fun deleteUser(id: String): Boolean {
    validateInput(id)
    dbExecute("DELETE FROM users WHERE id = $id")
    logRequest("user deleted")
    return true
}
`,
      'src/main/kotlin/service/AuthService.kt': `package service

fun authenticate(username: String, password: String): Map<String, Any> {
    validateInput(username)
    validateInput(password)
    val user = findUser(username)
    val hash = hashPassword(password)
    return formatResponse(mapOf("user" to user, "token" to createToken(username)))
}

fun hashPassword(password: String): String {
    validateInput(password)
    return "hashed_$password"
}

fun createToken(username: String): String {
    validateInput(username)
    logRequest("token created for $username")
    return "token_$username"
}

fun verifyToken(token: String): Boolean {
    validateInput(token)
    return token.startsWith("token_")
}

fun refreshToken(token: String): String {
    verifyToken(token)
    return createToken("refreshed")
}
`,
      'src/main/kotlin/service/NotificationService.kt': `package service

fun notify(userId: String, message: String) {
    validateInput(userId)
    validateInput(message)
    sendEmail(userId, message)
}

fun sendEmail(to: String, body: String) {
    sanitizeInput(body)
    logRequest("email sent to $to")
    formatMessage(body)
}

fun sendAlert(message: String) {
    logRequest("alert: $message")
    formatError(message)
}
`,
      'src/main/kotlin/helpers/Validator.kt': `package helpers

fun validateInput(input: String): Boolean {
    if (input.isEmpty()) throw IllegalArgumentException("Invalid")
    return true
}

fun sanitizeInput(input: String): String {
    return input.replace("<", "").replace(">", "")
}

fun checkLength(input: String, max: Int = 255): Boolean {
    return input.length <= max
}

fun normalizeInput(input: String): String {
    return input.trim().lowercase()
}
`,
      'src/main/kotlin/helpers/Logger.kt': `package helpers

fun logRequest(msg: String) {
    println("[REQ] $msg")
}

fun logError(msg: String) {
    System.err.println("[ERR] $msg")
}

fun logInfo(msg: String) {
    println("[INFO] $msg")
}

fun createLogEntry(level: String, msg: String): Map<String, Any> {
    return mapOf("level" to level, "msg" to msg, "ts" to System.currentTimeMillis())
}
`,
      'src/main/kotlin/helpers/Formatter.kt': `package helpers

fun formatResponse(data: Map<String, Any>): Map<String, Any> {
    return data + mapOf("formatted" to true, "status" to 200)
}

fun formatError(err: String): Map<String, Any> {
    return mapOf("status" to 500, "error" to err)
}

fun formatMessage(msg: String): String {
    return "[MSG] $msg"
}

fun formatDate(timestamp: Long): String {
    return timestamp.toString()
}
`,
      'src/main/kotlin/data/Database.kt': `package data

fun dbQuery(sql: String): Map<String, Any> {
    logRequest("query: $sql")
    return mapOf("rows" to emptyList<Any>())
}

fun dbExecute(sql: String): Boolean {
    logRequest("execute: $sql")
    return true
}

fun dbConnect(url: String): Boolean {
    return true
}

fun dbClose() {
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
   * Kotlin repo with service/repository clusters.
   */
  it('generates skill files', () => {
    assertSkillFiles(result, tmpDir);
  }, 50000);

  /**
   * Verify CLAUDE.md and AGENTS.md are created and reference generated skills.
   */
  it('context files updated', () => {
    assertContextFiles(result, tmpDir);
  }, 50000);
});
