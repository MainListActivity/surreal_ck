// 为 electrobun 间接依赖的 three.js 补充类型声明（三方库未提供 @types/three）
declare module "three" {
  const value: unknown;
  export default value;
  export * from "three";
}
