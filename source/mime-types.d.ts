declare module "mime-types" {
  const mimeTypes: {
    lookup(path: string): string | false;
  };
  export default mimeTypes;
}
