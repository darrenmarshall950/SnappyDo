/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

declare namespace App {
  interface Locals {
    /** Admin session when authenticated, null otherwise. */
    admin: { user: string; exp: number } | null;
  }
}
