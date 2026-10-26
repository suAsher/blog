import { ApiError } from "../../lib/documents";

export function errorMessage(error: unknown) {
  return error instanceof ApiError
    ? error.message
    : "操作暂时没有完成，请稍后重试。";
}
export function today() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
