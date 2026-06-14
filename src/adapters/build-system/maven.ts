import type { ScannedFile } from '../../types.js';
import { evidenceLineAt, localPackage } from './shared.js';
import type { ParsedManifest } from './types.js';

export function mavenSyntaxDiagnostics(file: ScannedFile): string[] {
  const withoutComments = stripXmlComments(file.content);
  if (/<project\b/i.test(withoutComments) && !/<\/project\s*>/i.test(withoutComments)) {
    return [`pom.xml parse failed: missing </project>: ${file.relativePath}`];
  }
  return [];
}

export function parseMavenPom(file: ScannedFile): ParsedManifest {
  const withoutComments = maskXmlComments(file.content);
  const parent = firstXmlBlock(withoutComments, 'parent');
  const projectWithoutParent = maskXmlBlocks(withoutComments, 'parent');
  const directProjectBody = stripMavenNestedModelSections(projectWithoutParent);
  const mavenProperties = mavenPropertyMap(firstXmlBlock(directProjectBody, 'properties'));
  const projectWithoutDeps = removeXmlBlocks(removeXmlBlocks(directProjectBody, 'dependencies'), 'dependencyManagement');
  const parentGroupId = resolveMavenPropertyValue(parent ? xmlTagText(parent, 'groupId') : undefined, mavenProperties);
  const parentArtifactId = resolveMavenPropertyValue(parent ? xmlTagText(parent, 'artifactId') : undefined, mavenProperties);
  const parentVersion = resolveMavenPropertyValue(parent ? xmlTagText(parent, 'version') : undefined, mavenProperties);
  const bootstrapProperties = mavenParentProperties(mavenProperties, parentGroupId, parentArtifactId, parentVersion);
  const groupId = resolveMavenPropertyValue(xmlTagText(projectWithoutDeps, 'groupId'), bootstrapProperties) ?? parentGroupId;
  const artifactId = resolveMavenPropertyValue(xmlTagText(projectWithoutDeps, 'artifactId'), bootstrapProperties);
  const version = resolveMavenPropertyValue(xmlTagText(projectWithoutDeps, 'version'), bootstrapProperties) ?? parentVersion;
  if (!artifactId) {
    return { dependencies: [], diagnostics: [`pom.xml missing artifactId: ${file.relativePath}`] };
  }
  const effectiveProperties = mavenEffectiveProperties(mavenProperties, {
    groupId,
    artifactId,
    version,
    parentGroupId,
    parentArtifactId,
    parentVersion
  });
  const displayName = groupId ? `${groupId}:${artifactId}` : artifactId;
  const pkg = localPackage('maven', displayName, file.relativePath, displayName, version, [
    displayName,
    artifactId
  ]);
  const dependencySource = maskXmlBlocks(directProjectBody, 'dependencyManagement');
  return {
    package: pkg,
    dependencies: xmlBlocks(dependencySource, 'dependency').flatMap((block) => {
      const depGroup = resolveMavenPropertyValue(xmlTagText(block.text, 'groupId'), effectiveProperties);
      const depArtifact = resolveMavenPropertyValue(xmlTagText(block.text, 'artifactId'), effectiveProperties);
      if (!depArtifact) return [];
      const depName = depGroup ? `${depGroup}:${depArtifact}` : depArtifact;
      return [{
        ecosystem: 'maven' as const,
        name: depName,
        displayName: depName,
        version: resolveMavenPropertyValue(xmlTagText(block.text, 'version'), effectiveProperties),
        dependencyType: resolveMavenPropertyValue(xmlTagText(block.text, 'scope'), effectiveProperties) ?? 'dependency',
        confidence: 'heuristic' as const,
        evidence: evidenceLineAt(file.content, file.relativePath, block.index)
      }];
    }),
    diagnostics: []
  };
}

function stripMavenNestedModelSections(content: string): string {
  let stripped = content;
  for (const tagName of ['profiles', 'build', 'reporting']) {
    stripped = maskXmlBlocks(stripped, tagName);
  }
  return stripped;
}

function mavenPropertyMap(propertiesBlock: string | undefined): Map<string, string> {
  const properties = new Map<string, string>();
  if (!propertiesBlock) return properties;
  for (const match of propertiesBlock.matchAll(/<([A-Za-z0-9_.-]+)\b[^>]*>\s*([^<]+?)\s*<\/\1>/g)) {
    properties.set(match[1]!, match[2]!.trim());
  }
  return properties;
}

function mavenEffectiveProperties(
  properties: ReadonlyMap<string, string>,
  values: {
    groupId: string | undefined;
    artifactId: string;
    version: string | undefined;
    parentGroupId: string | undefined;
    parentArtifactId: string | undefined;
    parentVersion: string | undefined;
  }
): Map<string, string> {
  const effective = new Map(properties);
  setMavenPropertyAliases(effective, ['project.groupId', 'pom.groupId'], values.groupId);
  setMavenPropertyAliases(effective, ['project.artifactId', 'pom.artifactId'], values.artifactId);
  setMavenPropertyAliases(effective, ['project.version', 'pom.version'], values.version);
  setMavenPropertyAliases(effective, ['project.parent.groupId', 'pom.parent.groupId'], values.parentGroupId);
  setMavenPropertyAliases(effective, ['project.parent.artifactId', 'pom.parent.artifactId'], values.parentArtifactId);
  setMavenPropertyAliases(effective, ['project.parent.version', 'pom.parent.version'], values.parentVersion);
  return effective;
}

function mavenParentProperties(
  properties: ReadonlyMap<string, string>,
  parentGroupId: string | undefined,
  parentArtifactId: string | undefined,
  parentVersion: string | undefined
): Map<string, string> {
  const effective = new Map(properties);
  setMavenPropertyAliases(effective, ['project.parent.groupId', 'pom.parent.groupId'], parentGroupId);
  setMavenPropertyAliases(effective, ['project.parent.artifactId', 'pom.parent.artifactId'], parentArtifactId);
  setMavenPropertyAliases(effective, ['project.parent.version', 'pom.parent.version'], parentVersion);
  return effective;
}

function setMavenPropertyAliases(
  properties: Map<string, string>,
  names: readonly string[],
  value: string | undefined
): void {
  if (!value) return;
  for (const name of names) properties.set(name, value);
}

function resolveMavenPropertyValue(
  value: string | undefined,
  properties: ReadonlyMap<string, string>
): string | undefined {
  if (!value) return undefined;
  let resolved = value;
  for (let depth = 0; depth < 6; depth += 1) {
    let changed = false;
    resolved = resolved.replace(/\$\{([^}]+)\}/g, (placeholder, key: string) => {
      const replacement = properties.get(key);
      if (replacement === undefined) return placeholder;
      changed = true;
      return replacement;
    });
    if (!changed) break;
  }
  return resolved;
}

function xmlBlocks(content: string, tagName: string): Array<{ text: string; index: number }> {
  const pattern = new RegExp(`<${tagName}\\b[^>]*>[\\s\\S]*?<\\/${tagName}>`, 'g');
  const blocks: Array<{ text: string; index: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    blocks.push({ text: match[0]!, index: match.index });
  }
  return blocks;
}

function firstXmlBlock(content: string, tagName: string): string | undefined {
  return xmlBlocks(content, tagName)[0]?.text;
}

function removeXmlBlocks(content: string, tagName: string): string {
  const pattern = new RegExp(`<${tagName}\\b[^>]*>[\\s\\S]*?<\\/${tagName}>`, 'g');
  return content.replace(pattern, '');
}

function maskXmlBlocks(content: string, tagName: string): string {
  const pattern = new RegExp(`<${tagName}\\b[^>]*>[\\s\\S]*?<\\/${tagName}>`, 'g');
  return content.replace(pattern, (match) => match.replace(/[^\r\n]/g, ' '));
}

function xmlTagText(content: string, tagName: string): string | undefined {
  const match = new RegExp(`<${tagName}\\b[^>]*>\\s*([^<]+?)\\s*<\\/${tagName}>`).exec(content);
  return match?.[1]?.trim();
}

function stripXmlComments(content: string): string {
  return content.replace(/<!--[\s\S]*?-->/g, '');
}

function maskXmlComments(content: string): string {
  return content.replace(/<!--[\s\S]*?-->/g, (match) => match.replace(/[^\r\n]/g, ' '));
}
