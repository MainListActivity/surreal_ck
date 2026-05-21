import { describe, expect, test } from "bun:test";
import * as ts from "typescript";

describe("同步 RPC 公共契约", () => {
  test("只暴露 v2 健康、重建与重连入口，不暴露 legacy 同步入口", async () => {
    const requestNames = await readAppRpcRequestNames();

    expect(requestNames).toContain("getSyncStatusV2");
    expect(requestNames).toContain("triggerSyncRebuild");
    expect(requestNames).toContain("reconnectRemote");
    expect(requestNames).not.toContain("getSyncStatus");
    expect(requestNames).not.toContain("listDeadLetters");
    expect(requestNames).not.toContain("discardDeadLetter");
    expect(requestNames).not.toContain("forceReapplyDeadLetter");
  });
});

async function readAppRpcRequestNames(): Promise<string[]> {
  const sourcePath = new URL("../../shared/rpc.types.ts", import.meta.url);
  const sourceText = await Bun.file(sourcePath).text();
  const source = ts.createSourceFile(sourcePath.pathname, sourceText, ts.ScriptTarget.Latest, true);
  const appRpc = source.statements.find((node): node is ts.InterfaceDeclaration =>
    ts.isInterfaceDeclaration(node) && node.name.text === "AppRPC",
  );
  if (!appRpc) throw new Error("AppRPC interface not found");

  const bun = findPropertyTypeLiteral(appRpc.members, "bun");
  const requests = findPropertyTypeLiteral(bun.members, "requests");
  return requests.members
    .filter(ts.isPropertySignature)
    .map((member) => propertyNameText(member.name))
    .filter((name): name is string => name !== null);
}

function findPropertyTypeLiteral(
  members: ts.NodeArray<ts.TypeElement>,
  name: string,
): ts.TypeLiteralNode {
  const member = members.find((node): node is ts.PropertySignature =>
    ts.isPropertySignature(node) && propertyNameText(node.name) === name,
  );
  if (!member || !member.type || !ts.isTypeLiteralNode(member.type)) {
    throw new Error(`${name} type literal not found`);
  }
  return member.type;
}

function propertyNameText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}
