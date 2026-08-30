export interface PermissionsAutoRunInstructions {
  readonly allowInstructions: readonly string[];
  readonly blockInstructions: readonly string[];
}

export interface SmartModeAutoRunInstructionProtos {
  readonly userPermissionsAutoRun?: PermissionsAutoRunInstructions;
  readonly projectPermissionsAutoRun?: PermissionsAutoRunInstructions;
  readonly adminPermissionsAutoRun?: PermissionsAutoRunInstructions;
}

export interface SmartModeAutoRunInstructions {
  readonly userAutoRunInstructions?: PermissionsAutoRunInstructions | undefined;
  readonly projectAutoRunInstructions?: PermissionsAutoRunInstructions | undefined;
  readonly hasAdminOverride: boolean;
}

export function projectPermissionsAutoRunFromProto(
  instructions: PermissionsAutoRunInstructions | undefined,
): PermissionsAutoRunInstructions | undefined {
  if (instructions === undefined) {
    return undefined;
  }
  const allowInstructions = instructions.allowInstructions.filter(
    instruction => instruction.length > 0,
  );
  const blockInstructions = instructions.blockInstructions.filter(
    instruction => instruction.length > 0,
  );
  if (allowInstructions.length === 0 && blockInstructions.length === 0) {
    return undefined;
  }
  return { allowInstructions, blockInstructions };
}

export function smartModeAutoRunInstructionsFromProtos({
  userPermissionsAutoRun,
  projectPermissionsAutoRun,
  adminPermissionsAutoRun,
}: SmartModeAutoRunInstructionProtos): SmartModeAutoRunInstructions {
  const adminAutoRunInstructions = projectPermissionsAutoRunFromProto(adminPermissionsAutoRun);
  if (adminAutoRunInstructions !== undefined) {
    return {
      projectAutoRunInstructions: adminAutoRunInstructions,
      hasAdminOverride: true,
    };
  }
  return {
    userAutoRunInstructions: projectPermissionsAutoRunFromProto(userPermissionsAutoRun),
    projectAutoRunInstructions: projectPermissionsAutoRunFromProto(projectPermissionsAutoRun),
    hasAdminOverride: false,
  };
}
