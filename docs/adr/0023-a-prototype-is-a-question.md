# 0023 · A prototype is a question, not a spec

Status: accepted for 3.0 (design), 25 Oct 2026. Also covers a developer prototype: To the Factory launches with the diff as reference, never skipping Spec. Supersedes 0017's "Make card writes the card and a spec issue the product owner reads first" and 0018's PT6 and PT7 (Spec skipped, Build takes the prototype as its reference). 0017's rule that a product owner never launches stands.

A product owner's prototype ends in a card asking "can we do this?", the prototype linked. No spec issue yet. A developer reads it and decides; launching it is the yes, and the Factory runs as for any card: the Decider, a grill when the card needs one, the spec, then Build, with the prototype as reference throughout.

**Why.** A prototype is a mock-up, more or less: injected JS/CSS and mocked answers, made to show an idea. Skipping Spec built the mock-up's assumptions straight into code with nobody grilling them (the owner, 25 Oct).

**Trade-offs.** A prototyped idea takes a spec round before Build, slower than 0018's straight-to-Build; in return every build has a spec a developer grilled and a product owner signed.

**Consequences.** Make card writes only the card (with the prototype's link and screenshots); the spec issue comes from the developer's launch.
