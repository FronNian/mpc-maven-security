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
    
    // Extract project info - resolve any property placeholders
    const rawName = project.name || project.artifactId || 'unknown';
    const projectName = this.resolveProperty(String(rawName), context.properties);
    
    // Use already-resolved version from context
    const projectVersion = context.projectVersion || '0.0.0';

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

    // Add local properties FIRST (override parent)
    // This is important because ${revision} etc. are defined in properties
    const localProps = this.extractProperties(project.properties);
    context.properties = { ...context.properties, ...localProps };

    // Set project coordinates for ${project.*} references
    // IMPORTANT: Resolve any property placeholders in version (e.g., ${revision})
    context.projectGroupId = project.groupId || project.parent?.groupId || context.projectGroupId;
    context.projectArtifactId = project.artifactId || context.projectArtifactId;
    
    // Resolve version - it might be ${revision} or similar
    let rawVersion = project.version || project.parent?.version || context.projectVersion || '';
    context.projectVersion = this.resolveProperty(String(rawVersion), context.properties);

    // Add standard Maven properties (after resolving version)
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

    // First try local paths
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

    // If not found locally, try to download from Maven Central
    const bomVersions = await this.downloadBomFromMaven(groupId, artifactId, version, context);
    if (bomVersions.size > 0) {
      this.bomCache.set(bomKey, bomVersions);
      for (const [key, value] of bomVersions) {
        if (!context.managedVersions.has(key)) {
          context.managedVersions.set(key, value);
        }
      }
    }

    // BOM not found locally - this is okay, versions might come from parent
  }

  /**
   * Download BOM from Maven Central and extract managed versions
   * Recursively processes nested BOM imports (e.g., spring-boot-dependencies)
   */
  private async downloadBomFromMaven(
    groupId: string,
    artifactId: string,
    version: string,
    context: ParseContext,
    depth: number = 0
  ): Promise<Map<string, string>> {
    const versions = new Map<string, string>();
    
    // Prevent infinite recursion
    if (depth > 5) {
      return versions;
    }

    const bomKey = `${groupId}:${artifactId}:${version}`;
    
    // Check cache first (avoid re-downloading)
    if (this.bomCache.has(bomKey)) {
      return new Map(this.bomCache.get(bomKey)!);
    }
    
    try {
      // Convert groupId to path format (e.g., org.springframework.boot -> org/springframework/boot)
      const groupPath = groupId.replace(/\./g, '/');
      const url = `https://repo1.maven.org/maven2/${groupPath}/${artifactId}/${version}/${artifactId}-${version}.pom`;
      
      // Fetch the POM file from Maven Central
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'mcp-maven-security/1.0'
        }
      });
      
      if (!response.ok) {
        return versions;
      }
      
      const content = await response.text();
      const pom = this.parser.parse(content) as PomXml;
      
      if (!pom.project) return versions;

      // Build BOM context with properties from the downloaded POM
      const bomProps = this.extractProperties(pom.project.properties);
      const bomContext: ParseContext = {
        properties: { ...context.properties, ...bomProps },
        managedVersions: new Map(),
        projectGroupId: groupId,
        projectArtifactId: artifactId,
        projectVersion: version
      };

      // Add standard Maven properties
      bomContext.properties['project.version'] = version;
      bomContext.properties['project.groupId'] = groupId;
      bomContext.properties['project.artifactId'] = artifactId;

      // Collect nested BOM imports to process after regular dependencies
      const nestedBomImports: Array<{ groupId: string; artifactId: string; version: string }> = [];

      // Extract managed versions from dependencyManagement
      const managedDeps = pom.project.dependencyManagement?.dependencies?.dependency;
      if (managedDeps) {
        const depArray = Array.isArray(managedDeps) ? managedDeps : [managedDeps];
        for (const dep of depArray) {
          if (dep.groupId && dep.artifactId && dep.version) {
            const depGroupId = this.resolveProperty(String(dep.groupId), bomContext.properties);
            const depArtifactId = this.resolveProperty(String(dep.artifactId), bomContext.properties);
            const depVersion = this.resolveProperty(String(dep.version), bomContext.properties);
            
            // Handle nested BOM imports (scope=import, type=pom)
            if (dep.scope === 'import' && dep.type === 'pom') {
              nestedBomImports.push({
                groupId: depGroupId,
                artifactId: depArtifactId,
                version: depVersion
              });
            } else {
              versions.set(`${depGroupId}:${depArtifactId}`, depVersion);
            }
          }
        }
      }

      // Process nested BOM imports recursively
      for (const nestedBom of nestedBomImports) {
        const nestedVersions = await this.downloadBomFromMaven(
          nestedBom.groupId,
          nestedBom.artifactId,
          nestedBom.version,
          bomContext,
          depth + 1
        );
        
        // Add nested versions (don't override existing - parent BOM takes precedence)
        for (const [key, value] of nestedVersions) {
          if (!versions.has(key)) {
            versions.set(key, value);
          }
        }
      }

      // Cache the result
      this.bomCache.set(bomKey, new Map(versions));
    } catch {
      // Failed to download or parse BOM from Maven Central
    }

    return versions;
  }

  /**
   * Parse a BOM file and extract its managed versions
   * Recursively processes nested BOM imports (both local and remote)
   */
  private async parseBomFile(bomPath: string, parentContext: ParseContext, depth: number = 0): Promise<Map<string, string>> {
    const versions = new Map<string, string>();
    
    // Prevent infinite recursion
    if (depth > 5) {
      return versions;
    }
    
    try {
      const content = await fs.readFile(bomPath, 'utf-8');
      const pom = this.parser.parse(content) as PomXml;
      
      if (!pom.project) return versions;

      // Build BOM context with properties (don't use buildContext to avoid circular BOM processing)
      const bomProps = this.extractProperties(pom.project.properties);
      const bomContext: ParseContext = {
        properties: { ...parentContext.properties, ...bomProps },
        managedVersions: new Map(),
        projectGroupId: pom.project.groupId || pom.project.parent?.groupId,
        projectArtifactId: pom.project.artifactId,
        projectVersion: pom.project.version || pom.project.parent?.version
      };

      // Add standard Maven properties
      if (bomContext.projectVersion) {
        bomContext.properties['project.version'] = bomContext.projectVersion;
      }
      if (bomContext.projectGroupId) {
        bomContext.properties['project.groupId'] = bomContext.projectGroupId;
      }
      if (bomContext.projectArtifactId) {
        bomContext.properties['project.artifactId'] = bomContext.projectArtifactId;
      }

      // Collect nested BOM imports to process
      const nestedBomImports: Array<{ groupId: string; artifactId: string; version: string }> = [];

      // Extract managed versions
      const managedDeps = pom.project.dependencyManagement?.dependencies?.dependency;
      if (managedDeps) {
        const depArray = Array.isArray(managedDeps) ? managedDeps : [managedDeps];
        for (const dep of depArray) {
          if (dep.groupId && dep.artifactId && dep.version) {
            const groupId = this.resolveProperty(String(dep.groupId), bomContext.properties);
            const artifactId = this.resolveProperty(String(dep.artifactId), bomContext.properties);
            const version = this.resolveProperty(String(dep.version), bomContext.properties);
            
            // Handle nested BOM imports (scope=import, type=pom)
            if (dep.scope === 'import' && dep.type === 'pom') {
              nestedBomImports.push({ groupId, artifactId, version });
            } else {
              versions.set(`${groupId}:${artifactId}`, version);
            }
          }
        }
      }

      // Process nested BOM imports recursively
      for (const nestedBom of nestedBomImports) {
        // First try to find nested BOM locally
        const possiblePaths = [
          path.resolve(path.dirname(bomPath), '..', `${nestedBom.artifactId}`, 'pom.xml'),
          path.resolve(path.dirname(bomPath), `${nestedBom.artifactId}`, 'pom.xml'),
        ];

        let nestedVersions: Map<string, string> | null = null;

        // Try local paths first
        for (const nestedBomPath of possiblePaths) {
          try {
            await fs.access(nestedBomPath);
            nestedVersions = await this.parseBomFile(nestedBomPath, bomContext, depth + 1);
            break;
          } catch {
            continue;
          }
        }

        // If not found locally, download from Maven Central
        if (!nestedVersions || nestedVersions.size === 0) {
          nestedVersions = await this.downloadBomFromMaven(
            nestedBom.groupId,
            nestedBom.artifactId,
            nestedBom.version,
            bomContext,
            depth + 1
          );
        }

        // Add nested versions (don't override existing - parent BOM takes precedence)
        if (nestedVersions) {
          for (const [key, value] of nestedVersions) {
            if (!versions.has(key)) {
              versions.set(key, value);
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
   * IMPORTANT: First builds COMPLETE version context from root (including all BOMs),
   * then passes this context to all modules for dependency resolution
   */
  async parseMultiModule(projectPath: string): Promise<ParseResult> {
    const pomPath = path.join(projectPath, 'pom.xml');
    
    // Step 1: Read and parse root POM
    const content = await fs.readFile(pomPath, 'utf-8');
    const pom = this.parser.parse(content) as PomXml;
    
    if (!pom.project) {
      throw createError(
        ErrorCode.INVALID_POM_STRUCTURE,
        'Invalid POM structure: missing project element',
        { path: pomPath }
      );
    }

    // Step 2: Build COMPLETE root context first (this downloads all BOMs including Spring Boot)
    // This is the key - we build the full context BEFORE parsing any modules
    const rootContext = await this.buildContext(pomPath, pom.project);
    
    // Log context size for debugging
    console.log(`[POM Parser] Root context built with ${rootContext.managedVersions.size} managed versions`);

    // Step 3: Extract root project info
    const rawName = pom.project.name || pom.project.artifactId || 'unknown';
    const projectName = this.resolveProperty(String(rawName), rootContext.properties);
    const projectVersion = rootContext.projectVersion || '0.0.0';

    // Step 4: Extract root dependencies using the complete context
    const rootDependencies = this.extractDependencies(pom.project, rootContext);

    // Step 5: Extract modules
    const modules = this.extractModules(pom.project);

    if (modules.length === 0) {
      return {
        projectName,
        projectVersion,
        dependencies: rootDependencies,
        modules
      };
    }

    // Step 6: Parse all modules with the COMPLETE inherited context
    const allDependencies: Dependency[] = [...rootDependencies];
    const seen = new Set<string>();
    
    // Track seen dependencies from root
    for (const dep of rootDependencies) {
      seen.add(`${dep.groupId}:${dep.artifactId}:${dep.version}`);
    }

    await this.parseModulesRecursive(
      projectPath, 
      modules, 
      rootContext,  // Pass the complete context with all BOM versions
      allDependencies, 
      seen
    );

    return {
      projectName,
      projectVersion,
      dependencies: allDependencies,
      modules
    };
  }

  /**
   * Recursively parse modules with inherited context
   * IMPORTANT: Uses the inherited context directly without re-resolving parent chain
   * This ensures all BOM versions from root are available
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

        // Build module context - start with inherited parent context
        // This preserves all BOM versions from root
        const moduleContext = await this.buildModuleContext(modulePomPath, pom.project, parentContext);
        
        // Extract dependencies using the complete context
        const moduleDeps = this.extractDependencies(pom.project, moduleContext);
        
        // Add unique dependencies
        for (const dep of moduleDeps) {
          const key = `${dep.groupId}:${dep.artifactId}:${dep.version}`;
          if (!seen.has(key)) {
            seen.add(key);
            allDependencies.push(dep);
          }
        }

        // Handle nested modules (e.g., lynflow-framework has sub-modules)
        const nestedModules = this.extractModules(pom.project);
        if (nestedModules.length > 0) {
          await this.parseModulesRecursive(
            path.join(basePath, moduleName),
            nestedModules,
            moduleContext,  // Pass module context to nested modules
            allDependencies,
            seen
          );
        }
      } catch (error) {
        // Log and skip modules that can't be parsed
        console.error(`[POM Parser] Failed to parse module ${moduleName}: ${error}`);
        continue;
      }
    }
  }

  /**
   * Build context for a module, inheriting from parent context
   * This is a simplified version that doesn't re-resolve the parent chain
   * since we already have the complete context from root
   */
  private async buildModuleContext(
    modulePomPath: string,
    project: NonNullable<PomXml['project']>,
    parentContext: ParseContext
  ): Promise<ParseContext> {
    // Start with inherited parent context (contains all BOM versions)
    const context: ParseContext = {
      properties: { ...parentContext.properties },
      managedVersions: new Map(parentContext.managedVersions),
      projectGroupId: parentContext.projectGroupId,
      projectArtifactId: parentContext.projectArtifactId,
      projectVersion: parentContext.projectVersion
    };

    // Add module's local properties (override parent)
    const localProps = this.extractProperties(project.properties);
    context.properties = { ...context.properties, ...localProps };

    // Update project coordinates for this module
    context.projectGroupId = project.groupId || project.parent?.groupId || context.projectGroupId;
    context.projectArtifactId = project.artifactId || context.projectArtifactId;
    
    // Resolve version - it might be ${revision} or similar
    const rawVersion = project.version || project.parent?.version || context.projectVersion || '';
    context.projectVersion = this.resolveProperty(String(rawVersion), context.properties);

    // Update Maven properties for this module
    this.addMavenProperties(context, project);

    // Process module's own dependencyManagement (if any)
    // This handles cases where a module adds its own managed dependencies
    await this.processDependencyManagement(modulePomPath, project, context);

    // Process active profiles
    this.processProfiles(project, context);

    return context;
  }

  /**
   * Clear BOM cache (useful for testing or memory management)
   */
  clearCache(): void {
    this.bomCache.clear();
  }
}

export const pomParser = new PomParser();
