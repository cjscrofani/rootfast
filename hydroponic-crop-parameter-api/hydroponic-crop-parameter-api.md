# Hydroponic Crop Parameter API

A free, public, queryable dataset of the target environmental conditions for hydroponically grown crops — pulled out of academic PDFs, university extension factsheets, and vendor literature, and turned into something a controller, a hobbyist, or an AI assistant can actually use.

## The pitch in one breath

If you ask "what EC should I target for romaine in week three?", the answer exists. It's in a Cornell handbook, an NC State factsheet, and three vendor blog posts that mostly agree. It's just not anywhere a machine — or a human in a hurry — can use. This closes that gap. Forty crops, four growth stages each, every number sourced and dated.

## The problem

Hydroponic growing is unusually parameter-driven. Unlike soil gardening, where the substrate buffers a lot of mistakes, recirculating hydroponics rewards precision: nutrient strength, pH, light intensity, daily light total, day and night temperatures, photoperiod, and humidity all need to land in a specific window for a specific crop at a specific growth stage. Miss the window and you get tipburn, bolting, blossom-end rot, weak stems, or a flat refusal to flower.

The numbers that define those windows exist. The Cornell CEA program has spent two decades writing handbooks for high-value greenhouse crops. The e-Gro consortium (NC State, Michigan State, and others) publishes per-crop nutritional factsheets. The University of Arizona's CEAC has produced bulletins. There are hundreds of peer-reviewed papers in *HortScience*, *Acta Horticulturae*, and similar journals.

All of it is in PDF.

PDF is a fine format for reading on a couch. It is a deeply hostile format for "I'd like my system to target the right nutrient strength at week three of the crop cycle" or for "let me ask an AI grow assistant a question and have the answer be grounded in published science instead of vibes."

## Why no one has done this

Universities are funded to publish papers and handbooks. Nobody at Cornell gets tenure for shipping JSON. Commercial nutrient companies — the General Hydroponics, Athena, Jack's of the world — have feed charts but treat them as competitive moat. The MIT OpenAg Food Computer project explicitly tried to crowdsource crop recipes from hobbyists and collapsed before producing a usable dataset, partly because the underlying social structure — volunteers digitizing peer-reviewed sources for free — is fragile.

The strongest signal that this gap is real: the most popular open-source Arduino hydroponics library hardcodes its crop targets directly into firmware, because there is nowhere to fetch them from at runtime.

## What's in it

For each crop and growth stage:

- Target electrical conductivity (the proxy for nutrient strength), as a range
- Target pH range
- Target light intensity at the canopy
- Target daily light total
- Day and night air temperature ranges
- Root zone temperature, where it's been studied separately
- Photoperiod
- Vapor pressure deficit, where data exists
- Notes on common failure modes at that stage
- Every number tagged with its source, year, and confidence rating

Forty crops is a reasonable v1 target — the leafy greens and herbs that dominate hobbyist and small-commercial hydroponics, plus the four canonical fruiting crops (tomato, cucumber, pepper, strawberry), plus a microgreens block.

## The opinionated design call

When sources disagree, the dataset returns both with their sources attached. It does not average. Averaging hides the disagreement, which is the exact failure mode that breaks growers' systems and erodes trust. If Cornell says one number and a vendor chart says another, the user — or the AI assistant downstream of the user — should know about it and pick.

## Who would use it

Hobbyist hardware builders are the obvious audience: the Hydruino Arduino ecosystem, ESPHome plant-care nodes, Home Assistant integrations, FarmBot. None of them have a structured source for crop targets right now.

The less obvious audience is everyone building AI plant assistants. Grounded data — sourced, dated, machine-readable — is the difference between a chatbot that confidently hallucinates EC targets and one that returns "Cornell says 1.2; General Hydroponics says 1.4; here are both, with citations." That gap is currently being filled badly, and a clean public source would be adopted fast.

Beyond hobbyists and AI: agriculture curricula at high schools and community colleges, small commercial CEA operators who want a starting recipe before they tune in-house, third-party app developers who want to ship plant-care features without becoming hydroponic experts themselves.

## What it unblocks

A grow controller that you point at a crop and a growth stage, and it auto-targets the right environment. A "what is wrong with my plant" diagnostic that compares your sensor readings to the published target range. A seed-to-harvest planner that respects daily light requirements. An educational app that shows kids why basil and tomatoes can't share a nutrient bath. A reference that updates itself.

## Why now

Three converging trends. Indoor growing has crossed from hobbyist curiosity into normal-person infrastructure — smart gardens are at Target, vertical farms are on supermarket shelves, university CEA programs are graduating their second generation of operators. LED hardware has dropped to the point where the limiting factor for a hobbyist is no longer "can I afford the light" but "do I know what the right light dose is." And large language models have created a massive new consumer of structured grounding data; the next year is going to see a lot of "AI plant assistants" launch, and they all need a source of truth.

The window for being the canonical source is small but it's open.

## The honest case against

Crop parameter data has real variance across sources. Cornell's lettuce EC isn't quite a vendor blog's lettuce EC, and both are arguably right for slightly different cultivars under slightly different conditions. Communicating that variance without making the dataset feel useless takes design work.

Universities update their handbooks rarely. The dataset will lag the actual research frontier by a few years.

And the audience, while passionate, is small. This is not a venture-scale project. It's a piece of infrastructure that sits quietly under a hundred other people's apps. The reward is being the thing everyone in a niche depends on without ever quite noticing.
