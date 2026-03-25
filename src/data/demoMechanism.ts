import { createEmptyModel, createNodeAt, addBarBetween, addNode, addSupportToNode } from "../lib/mechanism";
import { vec } from "../lib/geometry";
import type { MechanismModel } from "../types/mechanism";

export function createDemoMechanism(): MechanismModel {
  let model = createEmptyModel();

  const base = createNodeAt(vec(160, 240), "hinge");
  base.label = "Base";
  const crankEnd = createNodeAt(vec(260, 180), "hinge");
  crankEnd.label = "Manovella";
  const sliderPin = createNodeAt(vec(420, 240), "hinge");
  sliderPin.label = "Pistone";

  model = addNode(model, base);
  model = addNode(model, crankEnd);
  model = addNode(model, sliderPin);
  model = addBarBetween(model, base.id, crankEnd.id);
  model = addBarBetween(model, crankEnd.id, sliderPin.id);
  model = addSupportToNode(model, base.id, "fixed");
  model = addSupportToNode(model, sliderPin.id, "slider", 0);

  model.bars = model.bars.map((bar, index) => ({
    ...bar,
    label: index === 0 ? "Manovella" : "Biella",
    color: index === 0 ? "#ffb86c" : "#6aa0ff",
  }));

  return model;
}
