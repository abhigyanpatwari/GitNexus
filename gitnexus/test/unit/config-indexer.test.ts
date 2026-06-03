import { describe, it, expect } from 'vitest';
import {
  isConfigFile,
  extractProfile,
  filterConfigFiles,
  parsePropertiesFile,
  parseYamlFile,
  indexConfigFile,
  indexConfigFiles,
  propertyToGraphNode,
  PropertyData,
} from '../../src/core/ingestion/config-indexer.js';

describe('config-indexer', () => {
  // ============================================================================
  // File Pattern Detection
  // ============================================================================
  
  describe('isConfigFile', () => {
    it('should match application.properties', () => {
      expect(isConfigFile('application.properties')).toBe(true);
      expect(isConfigFile('src/main/resources/application.properties')).toBe(true);
    });
    
    it('should match application-{profile}.properties', () => {
      expect(isConfigFile('application-dev.properties')).toBe(true);
      expect(isConfigFile('application-test.properties')).toBe(true);
      expect(isConfigFile('application-prod.properties')).toBe(true);
    });
    
    it('should match application.yml and application.yaml', () => {
      expect(isConfigFile('application.yml')).toBe(true);
      expect(isConfigFile('application.yaml')).toBe(true);
    });
    
    it('should match application-{profile}.yml/yaml', () => {
      expect(isConfigFile('application-dev.yml')).toBe(true);
      expect(isConfigFile('application-test.yaml')).toBe(true);
      expect(isConfigFile('application-prod.yml')).toBe(true);
    });
    
    it('should not match other files', () => {
      expect(isConfigFile('app.properties')).toBe(false);
      expect(isConfigFile('config.properties')).toBe(false);
      expect(isConfigFile('settings.yml')).toBe(false);
      expect(isConfigFile('notconfig.yaml')).toBe(false);
    });
    
    it('should be case-insensitive for extensions', () => {
      expect(isConfigFile('application.YML')).toBe(true);
      expect(isConfigFile('application.YAML')).toBe(true);
      expect(isConfigFile('application-dev.YML')).toBe(true);
    });
  });
  
  describe('extractProfile', () => {
    it('should return undefined for default application.properties', () => {
      expect(extractProfile('application.properties')).toBeUndefined();
      expect(extractProfile('application.yml')).toBeUndefined();
    });
    
    it('should extract profile from filename', () => {
      expect(extractProfile('application-dev.properties')).toBe('dev');
      expect(extractProfile('application-test.yml')).toBe('test');
      expect(extractProfile('application-prod.yaml')).toBe('prod');
    });
    
    it('should handle profiles with underscores and hyphens', () => {
      expect(extractProfile('application-dev_local.properties')).toBe('dev_local');
      expect(extractProfile('application-prod-us.yml')).toBe('prod-us');
    });
    
    it('should return undefined for non-matching files', () => {
      expect(extractProfile('other.properties')).toBeUndefined();
      expect(extractProfile('config.yml')).toBeUndefined();
    });
  });
  
  describe('filterConfigFiles', () => {
    it('should filter config files from a list', () => {
      const files = [
        'src/main/resources/application.properties',
        'src/main/resources/application-dev.yml',
        'src/main/java/App.java',
        'src/main/resources/db/migration/V1.sql',
        'application-test.yaml',
      ];
      
      const result = filterConfigFiles(files);
      
      expect(result).toHaveLength(3);
      expect(result).toContain('src/main/resources/application.properties');
      expect(result).toContain('src/main/resources/application-dev.yml');
      expect(result).toContain('application-test.yaml');
    });
  });
  
  // ============================================================================
  // Properties File Parser
  // ============================================================================
  
  describe('parsePropertiesFile', () => {
    it('should parse simple key=value pairs', () => {
      const content = `server.port=8080
server.host=localhost
app.name=MyApp`;
      
      const result = parsePropertiesFile(content, 'application.properties');
      
      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({
        key: 'server.port',
        value: '8080',
        profile: undefined,
        filePath: 'application.properties',
        line: 1,
      });
      expect(result[1].key).toBe('server.host');
      expect(result[1].value).toBe('localhost');
    });
    
    it('should parse key:value pairs (alternative syntax)', () => {
      const content = `server.port: 8080
server.host: localhost`;
      
      const result = parsePropertiesFile(content, 'application.properties');
      
      expect(result).toHaveLength(2);
      expect(result[0].key).toBe('server.port');
      expect(result[0].value).toBe('8080');
    });
    
    it('should skip comments', () => {
      const content = `# This is a comment
server.port=8080
! Another comment
server.host=localhost`;
      
      const result = parsePropertiesFile(content, 'application.properties');
      
      expect(result).toHaveLength(2);
    });
    
    it('should skip empty lines', () => {
      const content = `server.port=8080

server.host=localhost

app.name=MyApp`;
      
      const result = parsePropertiesFile(content, 'application.properties');
      
      expect(result).toHaveLength(3);
    });
    
    it('should handle multi-line values with backslash continuation', () => {
      const content = `spring.datasource.url=jdbc:mysql://localhost:3306/\\
mydb?useSSL=false&\\
serverTimezone=UTC`;
      
      const result = parsePropertiesFile(content, 'application.properties');
      
      expect(result).toHaveLength(1);
      expect(result[0].key).toBe('spring.datasource.url');
      expect(result[0].value).toBe('jdbc:mysql://localhost:3306/mydb?useSSL=false&serverTimezone=UTC');
    });
    
    it('should include profile from filename', () => {
      const content = `server.port=8080`;
      
      const result = parsePropertiesFile(content, 'application-dev.properties');
      
      expect(result[0].profile).toBe('dev');
    });
    
    it('should handle values with equals sign', () => {
      const content = `app.url=https://example.com?key=value`;

      const result = parsePropertiesFile(content, 'application.properties');

      expect(result[0].key).toBe('app.url');
      expect(result[0].value).toBe('https://example.com?key=value');
    });

    it('should not include subsequent lines in property value (#74)', async () => {
      // (#74) The reproduction from the issue: tcbs-bond-trading
      // application.properties. The `logging.file` value was observed
      // to include the entire remainder of the file (#=====, INFO,
      // DEBUG, ...) instead of just `bond-trading`. The current
      // parser correctly truncates each property's value at the end
      // of its line — this test pins the behavior with the exact
      // multi-property file from the issue so it cannot regress.
      const content = `spring.datasource.url=jdbc:oracle:thin:@10.7.2.201:1521:tcbssit
spring.datasource.username=app_bond
spring.datasource.password=appbond1
spring.datasource.driverClassName=oracle.jdbc.driver.OracleDriver
#===========================================================================================
logging.file=bond-trading
logging.level.org.springframework.web=INFO
logging.level.com.tcbs=DEBUG`;

      const result = parsePropertiesFile(content, 'application.properties');
      const { propertyToGraphNode } = await import('../../src/core/ingestion/config-indexer.js');

      // Every value must be a single line — no embedded newlines, no
      // subsequent properties leaking in, no comment lines.
      for (const p of result) {
        expect(p.value).not.toContain('\n');
        expect(p.value).not.toContain('#===');
        // The value must not contain the start of any other property
        // key in the file.
        for (const other of result) {
          if (other.key !== p.key) {
            expect(p.value).not.toContain(other.key);
          }
        }
        // The graph node's content field must mirror the value exactly.
        const node = propertyToGraphNode(p);
        expect((node.properties as any).content).toBe(p.value);
      }

      // Spot check the specific values from the issue.
      const loggingFile = result.find(p => p.key === 'logging.file');
      expect(loggingFile?.value).toBe('bond-trading');
      const datasourceUrl = result.find(p => p.key === 'spring.datasource.url');
      expect(datasourceUrl?.value).toBe('jdbc:oracle:thin:@10.7.2.201:1521:tcbssit');
    });
    
    it('should handle whitespace around equals', () => {
      const content = `server.port  =  8080
server.host   =   localhost`;
      
      const result = parsePropertiesFile(content, 'application.properties');
      
      expect(result[0].key).toBe('server.port');
      expect(result[0].value).toBe('8080');
      expect(result[1].value).toBe('localhost');
    });
  });
  
  // ============================================================================
  // YAML File Parser
  // ============================================================================
  
  describe('parseYamlFile', () => {
    it('should parse flat YAML properties', () => {
      const content = `server:
  port: 8080
  host: localhost`;
      
      const result = parseYamlFile(content, 'application.yml');
      
      expect(result).toHaveLength(2);
      expect(result).toContainEqual({
        key: 'server.port',
        value: '8080',
        profile: undefined,
        filePath: 'application.yml',
        line: 2,
      });
      expect(result).toContainEqual({
        key: 'server.host',
        value: 'localhost',
        profile: undefined,
        filePath: 'application.yml',
        line: 3,
      });
    });
    
    it('should parse deeply nested YAML properties', () => {
      const content = `spring:
  datasource:
    url: jdbc:mysql://localhost
    username: root
    password: secret`;
      
      const result = parseYamlFile(content, 'application.yml');
      
      expect(result).toHaveLength(3);
      expect(result.find(p => p.key === 'spring.datasource.url')?.value).toBe('jdbc:mysql://localhost');
      expect(result.find(p => p.key === 'spring.datasource.username')?.value).toBe('root');
      expect(result.find(p => p.key === 'spring.datasource.password')?.value).toBe('secret');
    });
    
    it('should handle quoted strings', () => {
      const content = `app:
  name: "My App"
  description: 'A test app'`;
      
      const result = parseYamlFile(content, 'application.yml');
      
      expect(result.find(p => p.key === 'app.name')?.value).toBe('My App');
      expect(result.find(p => p.key === 'app.description')?.value).toBe('A test app');
    });
    
    it('should handle null values', () => {
      const content = `app:
  name: ~
  value: null`;
      
      const result = parseYamlFile(content, 'application.yml');
      
      expect(result.find(p => p.key === 'app.name')?.value).toBe('');
      expect(result.find(p => p.key === 'app.value')?.value).toBe('');
    });
    
    it('should skip comments', () => {
      const content = `# Comment
server:
  # Port config
  port: 8080`;
      
      const result = parseYamlFile(content, 'application.yml');
      
      expect(result).toHaveLength(1);
      expect(result[0].key).toBe('server.port');
    });
    
    it('should skip document markers', () => {
      const content = `---
server:
  port: 8080
---
app:
  name: test`;
      
      const result = parseYamlFile(content, 'application.yml');
      
      expect(result).toHaveLength(2);
      expect(result.find(p => p.key === 'server.port')?.value).toBe('8080');
      expect(result.find(p => p.key === 'app.name')?.value).toBe('test');
    });
    
    it('should include profile from filename', () => {
      const content = `server:
  port: 8081`;
      
      const result = parseYamlFile(content, 'application-dev.yml');
      
      expect(result[0].profile).toBe('dev');
    });
    
    it('should handle boolean and numeric values', () => {
      const content = `app:
  enabled: true
  count: 42
  ratio: 3.14`;
      
      const result = parseYamlFile(content, 'application.yml');
      
      expect(result.find(p => p.key === 'app.enabled')?.value).toBe('true');
      expect(result.find(p => p.key === 'app.count')?.value).toBe('42');
      expect(result.find(p => p.key === 'app.ratio')?.value).toBe('3.14');
    });
    
    it('should unescape YAML escape sequences', () => {
      const content = `app:
  multiline: "line1\\nline2"
  quoted: "say \\"hello\\""`;
      
      const result = parseYamlFile(content, 'application.yml');
      
      expect(result.find(p => p.key === 'app.multiline')?.value).toBe('line1\nline2');
      expect(result.find(p => p.key === 'app.quoted')?.value).toBe('say "hello"');
    });
  });
  
  // ============================================================================
  // Index Functions
  // ============================================================================
  
  describe('indexConfigFile', () => {
    it('should index properties file', () => {
      const content = `server.port=8080
server.host=localhost`;
      
      const result = indexConfigFile(content, 'application.properties');
      
      expect(result.properties).toHaveLength(2);
      expect(result.profile).toBeUndefined();
    });
    
    it('should index YAML file', () => {
      const content = `server:
  port: 8080`;
      
      const result = indexConfigFile(content, 'application-dev.yml');
      
      expect(result.properties).toHaveLength(1);
      expect(result.profile).toBe('dev');
    });
  });
  
  describe('indexConfigFiles', () => {
    it('should index multiple config files', () => {
      const files = [
        { path: 'application.properties', content: 'server.port=8080' },
        { path: 'application-dev.yml', content: 'server:\n  port: 8081' },
        { path: 'App.java', content: 'public class App {}' },
      ];
      
      const result = indexConfigFiles(files);
      
      expect(result).toHaveLength(2);
    });
  });
  
  describe('propertyToGraphNode', () => {
    it('should create Property GraphNode', () => {
      const prop: PropertyData = {
        key: 'server.port',
        value: '8080',
        profile: 'dev',
        filePath: 'application-dev.properties',
        line: 1,
      };
      
      const node = propertyToGraphNode(prop);
      
      expect(node.label).toBe('Property');
      expect(node.properties.name).toBe('server.port');
      expect(node.properties.content).toBe('8080');
      expect(node.properties.description).toBe('dev');
      expect(node.properties.filePath).toBe('application-dev.properties');
      expect(node.properties.startLine).toBe(1);
      expect(node.properties.endLine).toBe(1);
    });
  });
});