export type WorkspaceResourceUris = {
  workspace: string;
  contracts: string;
  crossRepoLinks: string;
};

export function workspaceResourceUri(workspaceName: string): string {
  return `parallax://workspaces/${encodeURIComponent(workspaceName)}`;
}

export function workspaceContractsResourceUri(workspaceName: string): string {
  return `${workspaceResourceUri(workspaceName)}/contracts`;
}

export function workspaceCrossRepoLinksResourceUri(workspaceName: string): string {
  return `${workspaceResourceUri(workspaceName)}/cross-repo-links`;
}

export function workspaceResources(workspaceName: string): WorkspaceResourceUris {
  return {
    workspace: workspaceResourceUri(workspaceName),
    contracts: workspaceContractsResourceUri(workspaceName),
    crossRepoLinks: workspaceCrossRepoLinksResourceUri(workspaceName)
  };
}
