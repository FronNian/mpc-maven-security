/**
 * POM file parser for Maven projects
 * Supports:
 * - Multi-module projects (ruoyi-vue-pro, JeecgBoot)
 * - BOM imports (Spring Boot, Spring Cloud)
 * - CI Friendly versions (${revision}, ${changelist})
 * - Nested property references
 * - Profile dependencies
 * - Parent chain resolution
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
    packaging?: string;
    parent?: {
      groupId?: string;
      artifactId?: string;
      version?: string;
      relativePath?: string;
    };
    properties?: Record<string, unknown>;
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
    profiles?: {
      profile?: PomProfile | PomProfile[];
    };
  };
}

interface PomDependency {
  groupId: string;
  artifactId: string;
  version?: string;
  scope?: string;
  type?: string;
  optional?: string | boolean;
}

interface PomProfile {
  id?: string;
  activation?: {
    activeByDefault?: boolean | string;
  };
  dependencies?: {
    dependency?: PomDependency | PomDependency[];
  };
  dependencyManagement?: {
    dependencies?: {
      dependency?: PomDependency | PomDependency[];
    };
  };
  properties?: Record<string, unknown>;
}

interface ParseContext {
  properties: Record<string, string>;
  managedVersions: Map<string, string>;
  projectGroupId?: string;
  projectArtifactId?: string;
  projectVersion?: string;
}

export class PomParser {
  private parser: XMLParser;
  // Cache for parsed BOMs to avoid re-parsing
  private bomCache: Map<string, Map<string, string>> = new Map();

  constructor() {
    this.parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      textNodeName: '#text',
      parseAttributeValue: false, // Keep as strings to preserve version formats
      trimValues: true
    });
  }

  /**
   * Parse a single pom.xml file with full parent chain resolution
   */
  async parse(pomPath: string, inheritedContext?: ParseContext): Promise<ParseResult> {
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
    
    // Build context: first resolve parent chain, then merge local
    const context = await this.buildContext(absolutePath, project, inheritedContext);
    
    // Extract project info
    const projectName = project.name || project.artifactId || 'unknown';
    const projectVersion = this.resolveProperty(
      project.version || project.parent?.version || '0.0.0',
      context.properties
    );

    // Extract dependencies using the full context
    const dependencies = this.extractDependencies(project, context);

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
   * Build context by resolving entire parent chain first
   * This ensures all properties and managedVersions are available
   */
  private async buildContext(
    currentPomPath: string,
    project: NonNullable<PomXml['project']>,
    inheritedContext?: ParseContext
  ): Promise<ParseContext> {
    // Start with inherited context or empty
    let context: ParseContext = inheritedContext 
      ? { 
          properties: { ...inheritedContext.properties }, 
          managedVersions: new Map(inheritedContext.managedVersions),
          projectGroupId: inheritedContext.projectGroupId,
          projectArtifactId: inheritedContext.projectArtifactId,
          projectVersion: inheritedContext.projectVersion
        }
      : { properties: {}, managedVersions: new Map() };

    // Resolve parent chain first (recursively)
    // Only resolve parent if we don't have inherited context (to avoid duplicate work)
    // OR if the parent is different from what we inherited
    if (project.parent && !inheritedContext) {
      const parentContext = await this.resolveParentContext(currentPomPath, project.parent);
      if (parentContext) {
        // Parent properties are base, local overrides
        context.properties = { ...parentContext.properties, ...context.properties };
        // Parent managed versions are base, local overrides
        for (const [key, value] of parentContext.managedVersions) {
          if (!context.managedVersions.has(key)) {
            context.managedVersions.set(key, value);
          }
        }
      }
    } else if (project.parent && inheritedContext) {
      // Even with inherited context, we might need to resolve additional parent chain
      // if the module's parent is different from the inherited context's source
      const parentContext = await this.resolveParentContext(currentPomPath, project.parent);
      if (parentContext) {
        // Merge parent context, but inherited takes precedence
        for (const [key, value] of Object.entries(parentContext.properties)) {
          if (!(key in context.properties)) {
            context.properties[key] = value;
          }
        }
        for (const [key, value] of parentContext.managedVersions) {
          if (!context.managedVersions.has(key)) {
            context.managedVersions.set(key, value);
          }
        }
      }
    }

    // Add local properties (override parent)
    const localProps = this.extractProperties(project.properties);
    context.properties = { ...context.properties, ...localProps };

    // Set project coordinates for ${project.*} references
    context.projectGroupId = project.groupId || project.parent?.groupId || context.projectGroupId;
    context.projectArtifactId = project.artifactId || context.projectArtifactId;
    context.projectVersion = project.version || project.parent?.version || context.projectVersion;

    // Add standard Maven properties
    this.addMavenProperties(context, project);

    // Add local dependencyManagement (override parent)
    await this.processDependencyManagement(currentPomPath, project, context);

    // Process active profiles
    this.processProfiles(project, context);

    return context;
  }

  /**
   * Add standard Maven properties that are always available
   */
  private addMavenProperties(context: ParseContext, project: NonNullable<PomXml['project']>): void {
    // Project coordinates
    if (context.projectVersion) {
      context.properties['project.version'] = context.projectVersion;
      context.properties['pom.version'] = context.projectVersion;
    }
    if (context.projectGroupId) {
      context.properties['project.groupId'] = context.projectGroupId;
      context.properties['pom.groupId'] = context.projectGroupId;
    }
    if (context.projectArtifactId) {
      context.properties['project.artifactId'] = context.projectArtifactId;
      context.properties['pom.artifactId'] = context.projectArtifactId;
    }

    // Parent references
    if (project.parent) {
      if (project.parent.version) {
        context.properties['project.parent.version'] = project.parent.version;
        context.properties['parent.version'] = project.parent.version;
      }
      if (project.parent.groupId) {
        context.properties['project.parent.groupId'] = project.parent.groupId;
      }
      if (project.parent.artifactId) {
        context.properties['project.parent.artifactId'] = project.parent.artifactId;
      }
    }

    // CI Friendly placeholders - default to project version if not set
    if (!context.properties['revision'] && context.projectVersion) {
      context.properties['revision'] = context.projectVersion;
    }
    if (!context.properties['sha1']) {
      context.properties['sha1'] = '';
    }
    if (!context.properties['changelist']) {
      context.properties['changelist'] = '';
    }
  }

  /**
   * Process dependencyManagement including BOM imports
   */
  private async processDependencyManagement(
    currentPomPath: string,
    project: NonNullable<PomXml['project']>,
    context: ParseContext
  ): Promise<void> {
    const managedDeps = project.dependencyManagement?.dependencies?.dependency;
    if (!managedDeps) return;

    const depArray = Array.isArray(managedDeps) ? managedDeps : [managedDeps];
    
    for (const dep of depArray) {
      if (!dep.groupId || !dep.artifactId) continue;

      const groupId = this.resolveProperty(String(dep.groupId), context.properties);
      const artifactId = this.resolveProperty(String(dep.artifactId), context.properties);
      const version = dep.version ? this.resolveProperty(String(dep.version), context.properties) : '';
      const scope = dep.scope;
      const type = dep.type;

      // Handle BOM imports (scope=import, type=pom)
      if (scope === 'import' && type === 'pom' && version) {
        await this.importBom(currentPomPath, groupId, artifactId, version, context);
      } else if (version) {
        // Regular dependency management entry
        context.managedVersions.set(`${groupId}:${artifactId}`, version);
      }
    }
  }

  /**
   * Import BOM (Bill of Materials) and add its managed versions
   */
  private async importBom(
    currentPomPath: string,
    groupId: string,
    artifactId: string,
    version: string,
    context: ParseContext
  ): Promise<void> {
    const bomKey = `${groupId}:${artifactId}:${version}`;
    
    // Check cache first
    if (this.bomCache.has(bomKey)) {
      const cachedVersions = this.bomCache.get(bomKey)!;
      for (const [key, value] of cachedVersions) {
        if (!context.managedVersions.has(key)) {
          context.managedVersions.set(key, value);
        }
      }
      return;
    }

    // Try to find BOM in local project structure
    // Common patterns: 
    // - ../xxx-dependencies/pom.xml
    // - ../xxx-bom/pom.xml
    const possiblePaths = [
      path.resolve(path.dirname(currentPomPath), '..', `${artifactId}`, 'pom.xml'),
      path.resolve(path.dirname(currentPomPath), `${artifactId}`, 'pom.xml'),
      path.resolve(path.dirname(currentPomPath), '..', '..', `${artifactId}`, 'pom.xml'),
    ];

    for (const bomPath of possiblePaths) {
      try {
        await fs.access(bomPath);
        const bomVersions = await this.parseBomFile(bomPath, context);
        
        // Cache the result
        this.bomCache.set(bomKey, bomVersions);
        
        // Add to context
        for (const [key, value] of bomVersions) {
          if (!context.managedVersions.has(key)) {
            context.managedVersions.set(key, value);
          }
        }
        return;
      } catch {
        // Try next path
        continue;
      }
    }

    // BOM not found locally - this is okay, versions might come from parent
  }

  /**
   * Parse a BOM file and extract its managed versions
   */
  private async parseBomFile(bomPath: string, parentContext: ParseContext): Promise<Map<string, string>> {
    const versions = new Map<string, string>();
    
    try {
      const content = await fs.readFile(bomPath, 'utf-8');
      const pom = this.parser.parse(content) as PomXml;
      
      if (!pom.project) return versions;

      // Build BOM context (may have its own parent)
      const bomContext = await this.buildContext(bomPath, pom.project, parentContext);

      // Extract managed versions
      const managedDeps = pom.project.dependencyManagement?.dependencies?.dependency;
      if (managedDeps) {
        const depArray = Array.isArray(managedDeps) ? managedDeps : [managedDeps];
        for (const dep of depArray) {
          if (dep.groupId && dep.artifactId && dep.version) {
            const groupId = this.resolveProperty(String(dep.groupId), bomContext.properties);
            const artifactId = this.resolveProperty(String(dep.artifactId), bomContext.properties);
            const version = this.resolveProperty(String(dep.version), bomContext.properties);
            
            // Skip BOM imports within BOM
            if (dep.scope !== 'import') {
              versions.set(`${groupId}:${artifactId}`, version);
            }
          }
        }
      }
    } catch {
      // Failed to parse BOM
    }

    return versions;
  }

  /**
   * Process profiles and add dependencies from active profiles
   */
  private processProfiles(project: NonNullable<PomXml['project']>, context: ParseContext): void {
    const profiles = project.profiles?.profile;
    if (!profiles) return;

    const profileArray = Array.isArray(profiles) ? profiles : [profiles];
    
    for (const profile of profileArray) {
      // Only process profiles that are active by default
      const isActive = profile.activation?.activeByDefault === true || 
                       profile.activation?.activeByDefault === 'true';
      
      if (isActive) {
        // Add profile properties
        if (profile.properties) {
          const profileProps = this.extractProperties(profile.properties);
          context.properties = { ...context.properties, ...profileProps };
        }

        // Add profile dependencyManagement
        const managedDeps = profile.dependencyManagement?.dependencies?.dependency;
        if (managedDeps) {
          const depArray = Array.isArray(managedDeps) ? managedDeps : [managedDeps];
          for (const dep of depArray) {
            if (dep.groupId && dep.artifactId && dep.version) {
              const groupId = this.resolveProperty(String(dep.groupId), context.properties);
              const artifactId = this.resolveProperty(String(dep.artifactId), context.properties);
              const version = this.resolveProperty(String(dep.version), context.properties);
              context.managedVersions.set(`${groupId}:${artifactId}`, version);
            }
          }
        }
      }
    }
  }


  /**
   * Resolve parent POM and get its full context
   */
  private async resolveParentContext(
    currentPomPath: string,
    parent: { groupId?: string; artifactId?: string; version?: string; relativePath?: string }
  ): Promise<ParseContext | null> {
    // Try relative path first (default is ../pom.xml)
    const relativePath = parent.relativePath !== undefined ? parent.relativePath : '../pom.xml';
    
    // Empty relativePath means no local parent
    if (relativePath === '') {
      return null;
    }

    const parentPath = path.resolve(path.dirname(currentPomPath), relativePath);
    
    try {
      await fs.access(parentPath);
      
      // Read and parse parent POM
      const content = await fs.readFile(parentPath, 'utf-8');
      const pom = this.parser.parse(content) as PomXml;
      
      if (!pom.project) {
        return null;
      }

      // Recursively build parent's context (this handles grandparent, etc.)
      return await this.buildContext(parentPath, pom.project);
    } catch {
      // Parent POM not found locally, skip
      return null;
    }
  }

  /**
   * Extract properties from POM, handling various value types
   */
  private extractProperties(props?: Record<string, unknown>): Record<string, string> {
    if (!props) return {};
    
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(props)) {
      if (typeof value === 'string') {
        result[key] = value;
      } else if (typeof value === 'number') {
        result[key] = String(value);
      } else if (typeof value === 'boolean') {
        result[key] = String(value);
      } else if (value && typeof value === 'object' && '#text' in value) {
        // Handle XML text nodes
        result[key] = String((value as { '#text': unknown })['#text']);
      }
    }
    return result;
  }

  /**
   * Resolve property placeholders in a string (with multiple passes for nested refs)
   */
  resolveProperty(value: string, properties: Record<string, string>): string {
    if (!value || typeof value !== 'string') return value;
    
    let result = value;
    let prevResult = '';
    let iterations = 0;
    const maxIterations = 10; // Prevent infinite loops
    
    // Keep resolving until no more changes (handles nested properties)
    while (result !== prevResult && iterations < maxIterations) {
      prevResult = result;
      iterations++;
      
      result = result.replace(/\$\{([^}]+)\}/g, (match, propName) => {
        const propValue = properties[propName];
        return propValue !== undefined ? propValue : match;
      });
    }
    
    return result;
  }

  /**
   * Extract dependencies from POM project using full context
   */
  private extractDependencies(
    project: NonNullable<PomXml['project']>,
    context: ParseContext
  ): Dependency[] {
    const deps: Dependency[] = [];
    const seen = new Set<string>();

    // Extract from main dependencies section
    this.extractDepsFromSection(project.dependencies?.dependency, context, deps, seen);

    // Extract from active profiles
    const profiles = project.profiles?.profile;
    if (profiles) {
      const profileArray = Array.isArray(profiles) ? profiles : [profiles];
      for (const profile of profileArray) {
        const isActive = profile.activation?.activeByDefault === true || 
                         profile.activation?.activeByDefault === 'true';
        if (isActive && profile.dependencies?.dependency) {
          this.extractDepsFromSection(profile.dependencies.dependency, context, deps, seen);
        }
      }
    }

    return deps;
  }

  /**
   * Extract dependencies from a dependency section
   */
  private extractDepsFromSection(
    rawDeps: PomDependency | PomDependency[] | undefined,
    context: ParseContext,
    deps: Dependency[],
    seen: Set<string>
  ): void {
    if (!rawDeps) return;

    const depArray = Array.isArray(rawDeps) ? rawDeps : [rawDeps];
    for (const dep of depArray) {
      const parsed = this.parseDependency(dep, context);
      if (parsed) {
        const key = `${parsed.groupId}:${parsed.artifactId}:${parsed.version}`;
        if (!seen.has(key)) {
          seen.add(key);
          deps.push(parsed);
        }
      }
    }
  }

  /**
   * Parse a single dependency element
   */
  private parseDependency(
    dep: PomDependency,
    context: ParseContext
  ): Dependency | null {
    if (!dep.groupId || !dep.artifactId) {
      return null;
    }

    const rawGroupId = String(dep.groupId);
    const rawArtifactId = String(dep.artifactId);
    const groupId = this.resolveProperty(rawGroupId, context.properties);
    const artifactId = this.resolveProperty(rawArtifactId, context.properties);
    
    // Try to get version: explicit > dependencyManagement > UNKNOWN
    let version: string;
    if (dep.version) {
      version = this.resolveProperty(String(dep.version), context.properties);
    } else {
      // Look up in managedVersions with multiple key formats
      // 1. Try resolved groupId:artifactId
      const resolvedKey = `${groupId}:${artifactId}`;
      // 2. Try raw (unresolved) groupId:artifactId (for property-based keys)
      const rawKey = `${rawGroupId}:${rawArtifactId}`;
      
      version = context.managedVersions.get(resolvedKey) 
             || context.managedVersions.get(rawKey)
             || 'UNKNOWN';
      
      // If still contains ${}, try to resolve it
      if (version.includes('${')) {
        version = this.resolveProperty(version, context.properties);
      }
    }

    // Final check: if version still has unresolved placeholders, mark as UNKNOWN
    if (version.includes('${')) {
      // Log for debugging - helps identify missing properties
      console.error(`[POM Parser] Unresolved version for ${groupId}:${artifactId}: ${version}`);
      version = 'UNKNOWN';
    }

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
   * First builds full context from root, then passes to all modules
   */
  async parseMultiModule(projectPath: string): Promise<ParseResult> {
    const pomPath = path.join(projectPath, 'pom.xml');
    
    // Parse root POM first to get full context
    const rootResult = await this.parse(pomPath);
    
    if (rootResult.modules.length === 0) {
      return rootResult;
    }

    // Build root context to pass to modules
    const content = await fs.readFile(pomPath, 'utf-8');
    const pom = this.parser.parse(content) as PomXml;
    const rootContext = pom.project 
      ? await this.buildContext(pomPath, pom.project)
      : { properties: {}, managedVersions: new Map<string, string>() };

    // Recursively parse all modules with inherited context
    const allDependencies: Dependency[] = [...rootResult.dependencies];
    const seen = new Set<string>();
    
    // Track seen dependencies from root
    for (const dep of rootResult.dependencies) {
      seen.add(`${dep.groupId}:${dep.artifactId}:${dep.version}`);
    }

    await this.parseModulesRecursive(
      projectPath, 
      rootResult.modules, 
      rootContext, 
      allDependencies, 
      seen
    );

    return {
      ...rootResult,
      dependencies: allDependencies
    };
  }

  /**
   * Recursively parse modules with inherited context
   */
  private async parseModulesRecursive(
    basePath: string,
    modules: string[],
    parentContext: ParseContext,
    allDependencies: Dependency[],
    seen: Set<string>
  ): Promise<void> {
    for (const moduleName of modules) {
      const modulePomPath = path.join(basePath, moduleName, 'pom.xml');
      
      try {
        // Read module POM
        const content = await fs.readFile(modulePomPath, 'utf-8');
        const pom = this.parser.parse(content) as PomXml;
        
        if (!pom.project) continue;

        // Build module context with parent context inherited
        const moduleContext = await this.buildContext(modulePomPath, pom.project, parentContext);
        
        // Extract dependencies
        const moduleDeps = this.extractDependencies(pom.project, moduleContext);
        
        // Add unique dependencies
        for (const dep of moduleDeps) {
          const key = `${dep.groupId}:${dep.artifactId}:${dep.version}`;
          if (!seen.has(key)) {
            seen.add(key);
            allDependencies.push(dep);
          }
        }

        // Handle nested modules
        const nestedModules = this.extractModules(pom.project);
        if (nestedModules.length > 0) {
          await this.parseModulesRecursive(
            path.join(basePath, moduleName),
            nestedModules,
            moduleContext,
            allDependencies,
            seen
          );
        }
      } catch {
        // Skip modules that can't be parsed
        continue;
      }
    }
  }

  /**
   * Clear BOM cache (useful for testing or memory management)
   */
  clearCache(): void {
    this.bomCache.clear();
  }
}

export const pomParser = new PomParser();
