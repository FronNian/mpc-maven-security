/**
 * POM file parser for Maven projects
 */

import { XMLParser } from 'fast-xml-parser';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Dependency, ParseResult } from '../types/index.js';
import { ErrorCode, createError } from '../types/errors.js';

interface PomXml {
  project?: {
    groupId?: string;
    artifactId?: string;
    version?: string;
    name?: string;
    parent?: {
      groupId?: string;
      artifactId?: string;
      version?: string;
      relativePath?: string;
    };
    properties?: Record<string, string>;
    dependencies?: {
      dependency?: PomDependency | PomDependency[];
    };
    dependencyManagement?: {
      dependencies?: {
        dependency?: PomDependency | PomDependency[];
      };
    };
    modules?: {
      module?: string | string[];
    };
  };
}

interface PomDependency {
  groupId: string;
  artifactId: string;
  version?: string;
  scope?: string;
  optional?: string | boolean;
}

export class PomParser {
  private parser: XMLParser;

  constructor() {
    this.parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      textNodeName: '#text',
      parseAttributeValue: true,
      trimValues: true
    });
  }

  /**
   * Parse a single pom.xml file
   */
  async parse(pomPath: string, inheritedProperties?: Record<string, string>): Promise<ParseResult> {
    const absolutePath = path.resolve(pomPath);
    
    // Check if file exists
    try {
      await fs.access(absolutePath);
    } catch {
      throw createError(
        ErrorCode.POM_NOT_FOUND,
        `POM file not found: ${absolutePath}`,
        { path: absolutePath }
      );
    }


    // Read and parse XML
    let content: string;
    try {
      content = await fs.readFile(absolutePath, 'utf-8');
    } catch (error) {
      throw createError(
        ErrorCode.POM_PARSE_ERROR,
        `Failed to read POM file: ${absolutePath}`,
        { path: absolutePath, error: String(error) }
      );
    }

    let pom: PomXml;
    try {
      pom = this.parser.parse(content) as PomXml;
    } catch (error) {
      throw createError(
        ErrorCode.POM_PARSE_ERROR,
        `Failed to parse POM XML: ${absolutePath}`,
        { path: absolutePath, error: String(error) }
      );
    }

    if (!pom.project) {
      throw createError(
        ErrorCode.INVALID_POM_STRUCTURE,
        'Invalid POM structure: missing project element',
        { path: absolutePath }
      );
    }

    const project = pom.project;
    
    // Merge inherited properties with local properties
    const localProperties = this.extractProperties(project.properties);
    const properties = { ...inheritedProperties, ...localProperties };
    
    // Handle parent POM if present
    let parentDependencies: Dependency[] = [];
    if (project.parent) {
      const parentResult = await this.resolveParentPom(absolutePath, project.parent, properties);
      if (parentResult) {
        parentDependencies = parentResult.dependencies;
        // Merge parent properties (local takes precedence)
        Object.assign(properties, parentResult.properties);
      }
    }
    
    // Extract project info
    const projectName = project.name || project.artifactId || 'unknown';
    const projectVersion = this.resolveProperty(
      project.version || project.parent?.version || '0.0.0',
      properties
    );

    // Extract dependencies and merge with parent
    const localDependencies = this.extractDependencies(project, properties);
    const dependencies = this.mergeDependencies(parentDependencies, localDependencies);

    // Extract modules
    const modules = this.extractModules(project);

    return {
      projectName,
      projectVersion,
      dependencies,
      modules
    };
  }

  /**
   * Extract properties from POM
   */
  private extractProperties(props?: Record<string, string>): Record<string, string> {
    if (!props) return {};
    
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(props)) {
      if (typeof value === 'string') {
        result[key] = value;
      } else if (typeof value === 'number') {
        result[key] = String(value);
      }
    }
    return result;
  }

  /**
   * Resolve parent POM and extract inherited dependencies/properties
   */
  private async resolveParentPom(
    currentPomPath: string,
    parent: { groupId?: string; artifactId?: string; version?: string; relativePath?: string },
    properties: Record<string, string>
  ): Promise<{ dependencies: Dependency[]; properties: Record<string, string> } | null> {
    // Try relative path first
    const relativePath = parent.relativePath || '../pom.xml';
    const parentPath = path.resolve(path.dirname(currentPomPath), relativePath);
    
    try {
      await fs.access(parentPath);
      const parentResult = await this.parse(parentPath, properties);
      return {
        dependencies: parentResult.dependencies,
        properties: this.extractProperties(properties)
      };
    } catch {
      // Parent POM not found locally, skip
      return null;
    }
  }

  /**
   * Merge parent and local dependencies (local takes precedence)
   */
  private mergeDependencies(parent: Dependency[], local: Dependency[]): Dependency[] {
    const result: Dependency[] = [];
    const seen = new Set<string>();
    
    // Add local dependencies first (they take precedence)
    for (const dep of local) {
      const key = `${dep.groupId}:${dep.artifactId}`;
      seen.add(key);
      result.push(dep);
    }
    
    // Add parent dependencies that aren't overridden
    for (const dep of parent) {
      const key = `${dep.groupId}:${dep.artifactId}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push(dep);
      }
    }
    
    return result;
  }

  /**
   * Resolve property placeholders in a string
   */
  resolveProperty(value: string, properties: Record<string, string>): string {
    if (!value) return value;
    
    const regex = /\$\{([^}]+)\}/g;
    let result = value;
    let match: RegExpExecArray | null;
    
    while ((match = regex.exec(value)) !== null) {
      const propName = match[1];
      const propValue = properties[propName];
      
      if (propValue !== undefined) {
        result = result.replace(match[0], propValue);
      }
    }
    
    return result;
  }


  /**
   * Extract dependencies from POM project
   */
  private extractDependencies(
    project: NonNullable<PomXml['project']>,
    properties: Record<string, string>
  ): Dependency[] {
    const deps: Dependency[] = [];
    const seen = new Set<string>();

    // Extract from dependencies section
    const rawDeps = project.dependencies?.dependency;
    if (rawDeps) {
      const depArray = Array.isArray(rawDeps) ? rawDeps : [rawDeps];
      for (const dep of depArray) {
        const parsed = this.parseDependency(dep, properties);
        if (parsed) {
          const key = `${parsed.groupId}:${parsed.artifactId}:${parsed.version}`;
          if (!seen.has(key)) {
            seen.add(key);
            deps.push(parsed);
          }
        }
      }
    }

    return deps;
  }

  /**
   * Parse a single dependency element
   */
  private parseDependency(
    dep: PomDependency,
    properties: Record<string, string>
  ): Dependency | null {
    if (!dep.groupId || !dep.artifactId) {
      return null;
    }

    const groupId = this.resolveProperty(dep.groupId, properties);
    const artifactId = this.resolveProperty(dep.artifactId, properties);
    const version = dep.version 
      ? this.resolveProperty(dep.version, properties) 
      : 'UNKNOWN';

    return {
      groupId,
      artifactId,
      version,
      scope: dep.scope,
      optional: dep.optional === true || dep.optional === 'true'
    };
  }

  /**
   * Extract module paths from POM
   */
  private extractModules(project: NonNullable<PomXml['project']>): string[] {
    const modules = project.modules?.module;
    if (!modules) return [];
    return Array.isArray(modules) ? modules : [modules];
  }

  /**
   * Parse a multi-module Maven project
   */
  async parseMultiModule(projectPath: string): Promise<ParseResult> {
    const pomPath = path.join(projectPath, 'pom.xml');
    const rootResult = await this.parse(pomPath);
    
    if (rootResult.modules.length === 0) {
      return rootResult;
    }

    // Recursively parse all modules
    const allDependencies: Dependency[] = [...rootResult.dependencies];
    const seen = new Set<string>();
    
    // Track seen dependencies from root
    for (const dep of rootResult.dependencies) {
      seen.add(`${dep.groupId}:${dep.artifactId}:${dep.version}`);
    }

    for (const moduleName of rootResult.modules) {
      const modulePath = path.join(projectPath, moduleName, 'pom.xml');
      
      try {
        const moduleResult = await this.parse(modulePath);
        
        // Add unique dependencies
        for (const dep of moduleResult.dependencies) {
          const key = `${dep.groupId}:${dep.artifactId}:${dep.version}`;
          if (!seen.has(key)) {
            seen.add(key);
            allDependencies.push(dep);
          }
        }

        // Recursively handle nested modules
        if (moduleResult.modules.length > 0) {
          const nestedResult = await this.parseMultiModule(
            path.join(projectPath, moduleName)
          );
          for (const dep of nestedResult.dependencies) {
            const key = `${dep.groupId}:${dep.artifactId}:${dep.version}`;
            if (!seen.has(key)) {
              seen.add(key);
              allDependencies.push(dep);
            }
          }
        }
      } catch {
        // Skip modules that can't be parsed
        continue;
      }
    }

    return {
      ...rootResult,
      dependencies: allDependencies
    };
  }
}

export const pomParser = new PomParser();
