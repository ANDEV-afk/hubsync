import type { ErrorRequestHandler } from "express";
import { isAppError } from "../lib/errors.js";

export const errorHandler: ErrorRequestHandler = (error,request,response,next) => {
  if (isAppError(error)) {
    response.status(error.statusCode).json({
      success: false,
      error: {
        code: error.code,
        message: error.message,
      },
    });
    return;
  }

  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(
    JSON.stringify({
      event: "unhandled_request_error",
      message,
    }),
  );

  response.status(500).json({
    success: false,
    error: {
      code: "INTERNAL_SERVER_ERROR",
      message: "An unexpected server error occurred",
    },
  });
};
