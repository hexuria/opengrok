import { createHash } from "node:crypto";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

export function parseMachO(bytes) {
  if (bytes.readUInt32LE(0) !== 0xfeedfacf) throw new Error("expected a thin arm64 Mach-O executable");
  const commandCount = bytes.readUInt32LE(16);
  let offset = 32;
  const commands = [];
  let signature;
  let uuid;
  let electronFramework;
  let buildVersion;
  for (let index = 0; index < commandCount; index += 1) {
    const command = bytes.readUInt32LE(offset);
    const size = bytes.readUInt32LE(offset + 4);
    if (size < 8 || offset + size > bytes.length) throw new Error("Mach-O load command is invalid");
    const record = { command, size, offset };
    if (command === 0x19) {
      record.name = bytes.subarray(offset + 8, offset + 24).toString("ascii").replaceAll("\0", "");
      record.vmSize = Number(bytes.readBigUInt64LE(offset + 32));
      record.fileOffset = Number(bytes.readBigUInt64LE(offset + 40));
      record.fileSize = Number(bytes.readBigUInt64LE(offset + 48));
      record.maxProtection = bytes.readInt32LE(offset + 56);
      record.initialProtection = bytes.readInt32LE(offset + 60);
      record.sectionCount = bytes.readUInt32LE(offset + 64);
      record.flags = bytes.readUInt32LE(offset + 68);
    } else if (command === 0x1b) {
      uuid = bytes.subarray(offset + 8, offset + 24).toString("hex");
    } else if (command === 0xc) {
      const nameOffset = bytes.readUInt32LE(offset + 8);
      const nameStart = offset + nameOffset;
      const nameEnd = bytes.indexOf(0, nameStart);
      const name = bytes.subarray(nameStart, nameEnd === -1 ? offset + size : nameEnd).toString("ascii");
      if (name.includes("Electron Framework.framework/Electron Framework")) electronFramework = name;
    } else if (command === 0x1d) {
      signature = { dataOffset: bytes.readUInt32LE(offset + 8), dataSize: bytes.readUInt32LE(offset + 12), commandOffset: offset };
    } else if (command === 0x32) {
      buildVersion = {
        platform: bytes.readUInt32LE(offset + 8),
        minOS: bytes.readUInt32LE(offset + 12),
        sdk: bytes.readUInt32LE(offset + 16),
        tools: bytes.readUInt32LE(offset + 20),
      };
    }
    commands.push(record);
    offset += size;
  }
  if (signature == null || signature.dataOffset + signature.dataSize !== bytes.length) throw new Error("Mach-O signature range is invalid");
  return {
    magic: bytes.readUInt32LE(0),
    cpuType: bytes.readInt32LE(4),
    cpuSubtype: bytes.readInt32LE(8),
    fileType: bytes.readUInt32LE(12),
    commandCount,
    commandsSize: bytes.readUInt32LE(20),
    commands,
    signature,
    uuid,
    electronFramework,
    buildVersion,
  };
}

export function signatureExcludedMachOHash(bytes, parsed = parseMachO(bytes)) {
  const normalized = Buffer.from(bytes.subarray(0, parsed.signature.dataOffset));
  for (const command of parsed.commands) {
    if (command.name === "__LINKEDIT") {
      normalized.writeBigUInt64LE(0n, command.offset + 32);
      normalized.writeBigUInt64LE(0n, command.offset + 40);
      normalized.writeBigUInt64LE(0n, command.offset + 48);
    }
    if (command.command === 0x1d) normalized.writeUInt32LE(0, command.offset + 12);
  }
  return sha256(normalized);
}

export function structuralMachOFingerprint(parsed) {
  return JSON.stringify({
    magic: parsed.magic,
    cpuType: parsed.cpuType,
    cpuSubtype: parsed.cpuSubtype,
    fileType: parsed.fileType,
    commandCount: parsed.commandCount,
    commandsSize: parsed.commandsSize,
    commands: parsed.commands.map(command => ({
      command: command.command,
      size: command.size,
      name: command.name,
      maxProtection: command.maxProtection,
      initialProtection: command.initialProtection,
      sectionCount: command.sectionCount,
      flags: command.flags,
    })),
    uuid: parsed.uuid,
    electronFramework: parsed.electronFramework,
    buildVersion: parsed.buildVersion,
  });
}

export function inspectReconstructedMacShell(officialBytes, reconstructedBytes) {
  const official = parseMachO(officialBytes);
  const reconstructed = parseMachO(reconstructedBytes);
  return {
    officialMachO: official,
    reconstructedMachO: reconstructed,
    officialNormalizedHash: signatureExcludedMachOHash(officialBytes, official),
    reconstructedNormalizedHash: signatureExcludedMachOHash(reconstructedBytes, reconstructed),
    structuralMatch: structuralMachOFingerprint(official) === structuralMachOFingerprint(reconstructed),
    officialHash: sha256(officialBytes),
    reconstructedHash: sha256(reconstructedBytes),
  };
}
