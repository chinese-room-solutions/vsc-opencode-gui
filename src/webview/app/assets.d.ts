// Binary imports the esbuild dataurl loader inlines into the bundle.
declare module "*.mp3" {
  const src: string;
  export default src;
}
