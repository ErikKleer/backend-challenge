import type { LoggerService } from "@nestjs/common";
import pino, { type DestinationStream, type Logger } from "pino";
import { getContext } from "./execution-context";
import { redactSensitive } from "./redaction";

export interface AppLoggerOptions {
  level: string;
  /** Destino das linhas JSON; padrão é stdout. Injetável para testes. */
  destination?: DestinationStream;
}

export type LogFields = Record<string, unknown>;

type Level = "debug" | "info" | "warn" | "error" | "fatal";

/**
 * Logger estruturado (JSON, uma linha por evento). Cada linha recebe o
 * contexto de execução corrente (`correlationId`, `messageId`,
 * `transactionId`, `walletId`, `providerId`).
 *
 * Regra: logar identificadores e resultados (status, failureCode), nunca
 * valores monetários nem payloads completos. `redactSensitive` é a rede de
 * segurança, não a política: quem loga não deve passar esses campos.
 *
 * Implementa `LoggerService` para substituir o logger do Nest (`useLogger`).
 */
export class AppLogger implements LoggerService {
  private readonly logger: Logger;

  constructor(options: AppLoggerOptions) {
    this.logger = pino(
      {
        level: options.level,
        base: undefined,
        timestamp: pino.stdTimeFunctions.isoTime,
        formatters: {
          level: (label) => ({ level: label }),
          log: (fields) => redactSensitive(fields) as Record<string, unknown>,
        },
        mixin: () => ({ ...getContext() }),
      },
      options.destination,
    );
  }

  // ---- API de log
  // Duas formas de chamada, pois a mesma classe também é o `LoggerService` do
  // Nest: `info("msg", { campo })` na aplicação e `log("msg", "Contexto")` /
  // `error("msg", stack, "Contexto")` no framework.

  public debug(message: unknown, ...params: unknown[]): void {
    this.write("debug", message, params);
  }

  public info(message: unknown, ...params: unknown[]): void {
    this.write("info", message, params);
  }

  public log(message: unknown, ...params: unknown[]): void {
    this.write("info", message, params);
  }

  public warn(message: unknown, ...params: unknown[]): void {
    this.write("warn", message, params);
  }

  public error(message: unknown, ...params: unknown[]): void {
    this.write("error", message, params);
  }

  public fatal(message: unknown, ...params: unknown[]): void {
    this.write("fatal", message, params);
  }

  public verbose(message: unknown, ...params: unknown[]): void {
    this.write("debug", message, params);
  }

  private write(level: Level, message: unknown, params: unknown[]): void {
    const text = typeof message === "string" ? message : String(message);
    const [first] = params;
    if (typeof first === "object" && first !== null) {
      this.logger[level](first, text);
      return;
    }

    const strings = params.filter((p): p is string => typeof p === "string");
    const fields: LogFields = {};
    if (level === "error" && strings.length > 1) {
      fields.stack = strings[0];
    }
    const context = strings[strings.length - 1];
    if (context !== undefined) {
      fields.context = context;
    }
    this.logger[level](fields, text);
  }
}
