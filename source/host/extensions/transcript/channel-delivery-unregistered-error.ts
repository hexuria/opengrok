export class SandChannelDeliveryUnregisteredError extends Error {
  constructor() {
    super("No channel delivery mechanism is registered.");
    this.name = "SandChannelDeliveryUnregisteredError";
  }
}
