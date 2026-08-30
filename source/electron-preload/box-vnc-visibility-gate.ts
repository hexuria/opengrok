export interface ViewerVisibilityGate {
  isVisible(): boolean;
  update(value: unknown): boolean;
}

export function createViewerVisibilityGate(): ViewerVisibilityGate {
  let isVisible = false;
  return {
    isVisible: () => isVisible,
    update(value) {
      const next = value === true;
      const becameVisible = next && !isVisible;
      isVisible = next;
      return becameVisible;
    },
  };
}
