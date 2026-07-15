export interface CliCommandRequest {
  command: string;
  options: Record<string, string | boolean>;
  positionals: string[];
}

export type CliCommandHandler<T extends CliCommandRequest = CliCommandRequest> = (request: T) => void | Promise<void>;
export type CliCommandRegistry<T extends CliCommandRequest = CliCommandRequest> = Readonly<Record<string, CliCommandHandler<T>>>;

export async function dispatchCliCommand<T extends CliCommandRequest>(
  request: T,
  registry: CliCommandRegistry<T>
): Promise<boolean> {
  const handler = registry[request.command];
  if (!handler) return false;
  await handler(request);
  return true;
}
