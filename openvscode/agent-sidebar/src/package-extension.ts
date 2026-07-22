import { notImplemented } from './not-implemented.ts';

export interface StageSidebarExtensionOptions {
  readonly sourceDirectory: string;
  readonly rootDirectory: string;
}

export interface StagedSidebarExtension {
  readonly sharedExtension: string;
  readonly inventories: Readonly<{
    pi: string;
    claude: string;
    none: string;
  }>;
}

export async function stageSidebarExtension(
  options: StageSidebarExtensionOptions,
): Promise<StagedSidebarExtension> {
  void options;
  return notImplemented('fixed OpenVSCode sidebar extension staging');
}
