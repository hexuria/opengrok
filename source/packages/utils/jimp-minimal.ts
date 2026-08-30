let jimpPromise: Promise<Awaited<ReturnType<typeof createJimpInstance>>> | undefined;

async function createJimpInstance() {
  const [
    { createJimp },
    { default: png },
    { default: jpeg },
    { default: bmp, msBmp },
    { default: gif },
    { default: tiff },
    { methods: resizeMethods },
  ] = await Promise.all([
    import("@jimp/core"),
    import("@jimp/js-png"),
    import("@jimp/js-jpeg"),
    import("@jimp/js-bmp"),
    import("@jimp/js-gif"),
    import("@jimp/js-tiff"),
    import("@jimp/plugin-resize"),
  ]);
  return createJimp({
    formats: [png, jpeg, bmp, msBmp, gif, tiff],
    plugins: [resizeMethods],
  });
}

export function getMinimalJimp(): Promise<Awaited<ReturnType<typeof createJimpInstance>>> {
  if (jimpPromise === undefined) {
    const initialization = createJimpInstance().catch((error: unknown) => {
      if (jimpPromise === initialization) jimpPromise = undefined;
      throw error;
    });
    jimpPromise = initialization;
  }
  return jimpPromise;
}
