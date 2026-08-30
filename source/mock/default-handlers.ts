import { MethodKind, type ServiceType } from "@bufbuild/protobuf";

/**
 * Empty/default protobuf implementation for every method on a Connect service.
 * Unary and client-streaming methods return `new Output()`. Streaming methods
 * complete immediately with no frames. Used so unused RPCs never throw
 * unimplemented.
 */
export function createDefaultServiceImpl(service: ServiceType): Record<string, (...args: never[]) => unknown> {
  const impl: Record<string, (...args: never[]) => unknown> = {};
  for (const [localName, method] of Object.entries(service.methods)) {
    const Output = method.O;
    switch (method.kind) {
      case MethodKind.ServerStreaming:
      case MethodKind.BiDiStreaming:
        impl[localName] = async function* () {};
        break;
      default:
        impl[localName] = () => new Output();
        break;
    }
  }
  return impl;
}
