import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "../src/App.tsx";
import { fakeApi, slow } from "./fakeApi.ts";

async function shop(api = fakeApi()) {
  const { unmount } = render(<App api={api} />);
  await screen.findByRole("listitem", { name: "Assam Breakfast" });
  await screen.findByText("Your cart is empty.");
  return { api, unmount, user: userEvent.setup() };
}

function cartLine(name: string) {
  return within(screen.getByRole("complementary", { name: "Cart" })).getByRole("listitem", {
    name,
  });
}

describe("the shop", () => {
  it("lists the products with their prices", async () => {
    await shop();
    const assam = screen.getByRole("listitem", { name: "Assam Breakfast" });
    expect(within(assam).getByText("€9.90")).toBeInTheDocument();
    expect(screen.getByRole("listitem", { name: "Stoneware Mug" })).toHaveTextContent("€16.00");
  });

  it("puts a product in the cart and shows the line and the total", async () => {
    const { user } = await shop();
    const mug = screen.getByRole("listitem", { name: "Stoneware Mug" });
    await user.click(within(mug).getByRole("button", { name: "Add to cart" }));

    await screen.findByRole("button", { name: "Remove Stoneware Mug" });
    expect(cartLine("Stoneware Mug")).toHaveTextContent("€16.00");
    expect(screen.getByTestId("cart-total")).toHaveTextContent("€16.00");
  });

  it("changes a line's quantity with + and −, and × takes it out", async () => {
    const { user } = await shop();
    const assam = screen.getByRole("listitem", { name: "Assam Breakfast" });
    await user.click(within(assam).getByRole("button", { name: "Add to cart" }));

    await user.click(await screen.findByRole("button", { name: "One more Assam Breakfast" }));
    await user.click(await screen.findByRole("button", { name: "One more Assam Breakfast" }));
    expect(await within(cartLine("Assam Breakfast")).findByText("3")).toBeInTheDocument();
    expect(cartLine("Assam Breakfast")).toHaveTextContent("€29.70");

    await user.click(screen.getByRole("button", { name: "One less Assam Breakfast" }));
    expect(await within(cartLine("Assam Breakfast")).findByText("2")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Remove Assam Breakfast" }));
    expect(await screen.findByText("Your cart is empty.")).toBeInTheDocument();
  });

  it("counts every quick press while the API is still answering", async () => {
    const { user } = await shop(slow(fakeApi()));
    const assam = screen.getByRole("listitem", { name: "Assam Breakfast" });
    await user.click(within(assam).getByRole("button", { name: "Add to cart" }));
    const more = await screen.findByRole("button", { name: "One more Assam Breakfast" });
    await user.click(more);
    await user.click(more);
    await user.click(more);
    expect(await within(cartLine("Assam Breakfast")).findByText("4")).toBeInTheDocument();
  });

  it("prints the total the API gives", async () => {
    const { user } = await shop(fakeApi(() => 4242));
    const mug = screen.getByRole("listitem", { name: "Stoneware Mug" });
    await user.click(within(mug).getByRole("button", { name: "Add to cart" }));
    await screen.findByRole("button", { name: "Remove Stoneware Mug" });
    expect(screen.getByTestId("cart-total")).toHaveTextContent("€42.42");
  });

  it("keeps the browser's cart across a reload", async () => {
    const api = fakeApi();
    const first = await shop(api);
    const mug = screen.getByRole("listitem", { name: "Stoneware Mug" });
    await first.user.click(within(mug).getByRole("button", { name: "Add to cart" }));
    await screen.findByRole("button", { name: "Remove Stoneware Mug" });
    first.unmount();

    render(<App api={api} />);
    expect(await screen.findByRole("button", { name: "Remove Stoneware Mug" })).toBeInTheDocument();
    expect(api.carts.size).toBe(1);
  });
});
