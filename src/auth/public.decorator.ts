import { SetMetadata } from "@nestjs/common";

export const IS_PUBLIC_KEY = "auth:isPublic";

/**
 * Marca uma rota (ou controller) que nunca exigirá autenticação, como `/health/*`
 * e `/metrics` (README §2). O guard real deve respeitar esta marca.
 */
export const Public = (): MethodDecorator & ClassDecorator =>
  SetMetadata(IS_PUBLIC_KEY, true);
