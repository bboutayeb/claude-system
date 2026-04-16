// Bun allows importing .sql files as text via `with { type: "text" }`.
// TypeScript doesn't know these extensions — declare them explicitly.
declare module "*.sql" {
  const content: string
  export default content
}
