export interface Resolution { width: number; height: number }
export interface ResolutionConfig { display: Resolution; api: Resolution }

export class CoordinateScaler {
  private readonly xScaleUp: number;
  private readonly yScaleUp: number;
  private readonly xScaleDown: number;
  private readonly yScaleDown: number;

  constructor(private readonly config: ResolutionConfig) {
    const displayRatio = config.display.width / config.display.height;
    const apiRatio = config.api.width / config.api.height;
    if (Math.abs(displayRatio - apiRatio) > 0.02) {
      throw new Error(`Aspect ratio mismatch: display=${displayRatio.toFixed(3)}, api=${apiRatio.toFixed(3)}`);
    }
    this.xScaleUp = config.display.width / config.api.width;
    this.yScaleUp = config.display.height / config.api.height;
    this.xScaleDown = config.api.width / config.display.width;
    this.yScaleDown = config.api.height / config.display.height;
  }

  apiToDisplay(x: number, y: number): { x: number; y: number } {
    return { x: Math.round(x * this.xScaleUp), y: Math.round(y * this.yScaleUp) };
  }
  displayToApi(x: number, y: number): { x: number; y: number } {
    return { x: Math.round(x * this.xScaleDown), y: Math.round(y * this.yScaleDown) };
  }
  get apiWidth(): number { return this.config.api.width; }
  get apiHeight(): number { return this.config.api.height; }
  get displayWidth(): number { return this.config.display.width; }
  get displayHeight(): number { return this.config.display.height; }
}
