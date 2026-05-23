import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import Home from "./page";

afterEach(cleanup);

describe("Home", () => {
  it("renders the heading", () => {
    render(<Home />);
    expect(screen.getByText("Firebase + Next.js Template")).toBeDefined();
  });
});
