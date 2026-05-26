# Native Plant Finder API

A free, public dataset that answers the question: "I live here. What should I plant?"

Not "what *can* I plant" — every nursery website can rattle off a thousand zone-appropriate cultivars. The specific question is *native* species: plants that evolved alongside the local soil, climate, and insect community, that support the pollinators and birds your region actually has, and that won't escape into the surrounding ecosystem.

## The pitch in one breath

Take USDA PLANTS' county-level native range data, join it to USDA hardiness zones, layer on bloom time, layer on Xerces Society pollinator value, and serve the result. Ask it for a latitude and longitude or a ZIP code, and get back the native species that thrive there, what they support, when they bloom, and what conditions they want. Everything that gardening forums spend thousands of hours per year reconstructing manually.

## The problem

If you want to plant natives, the current path is a scavenger hunt. The Audubon Native Plants Database takes a ZIP code and returns a useful species list — but it's an HTML page, not a queryable dataset, and it tells you nothing about bloom timing, sun preference, soil type, or which specific pollinators each plant supports. The USDA PLANTS Database has the authoritative county-level distribution data, but its interface is a 1990s government database with no awareness of why a normal gardener would ever visit. State native plant societies publish PDFs and printed booklets. The Xerces Society has excellent pollinator-value lists, but they're regional pamphlets, not data.

To answer "what native plants should I put in the strip between my driveway and the sidewalk, that will bloom from May through September, support native bees, and tolerate poor soil" — a question every homeowner trying to do the right thing will ask once a year — you currently need to cross-reference five sources, all of which are HTML or PDF, and most of which assume you already know botanical Latin.

This is solvable. The data exists. Nothing about it should be hard.

## Why this is a real gap

The native plant movement has exploded over the last decade. Doug Tallamy's *Bringing Nature Home* and *Nature's Best Hope* turned a niche conservation argument into a mainstream gardening identity. Municipalities are passing no-mow-May ordinances and converting strips of lawn to pollinator habitat. State DOTs are seeding native wildflowers in highway medians. Nurseries that stock natives are growing fast.

The data infrastructure has not caught up. Every native plant gardener is reinventing the same county-level cross-reference from scratch, every spring, manually. Every regional landscape designer has built their own spreadsheet. Every well-meaning HOA committee has muddled through one. There is no canonical, queryable, free source that joins the four datasets that actually matter.

The big gardening apps don't fill this gap because their business model depends on selling plants and tools, and native plants — especially the unglamorous ones that do the heavy ecological lifting — don't move units the way hydrangeas do. There's no commercial incentive for Burpee or Monrovia to make this easy. There is, however, a strong public-good case for someone outside the industry to just do it.

## What's in it

For any location, the system returns the plant species native to that county, along with:

- Hardiness-zone fit
- Bloom period (start month, peak, end month)
- Bloom color
- Mature size
- Sun and moisture preferences
- Soil type tolerances
- Pollinator value, broken down by pollinator group (native bees, butterflies, hummingbirds, specialist bees)
- Bird value (berries, seeds, nesting cover)
- Host-plant relationships (caterpillars supported — the metric Tallamy's research is built around)
- Whether commercial seed or plugs are reliably available
- Caveats — toxicity, aggressive spreaders, deer browse pressure

And the reverse query: given constraints, return the plants that match. "Show me everything native to Gallatin County, Montana, that blooms in July, tolerates dry rocky soil, and supports native bumblebees." This is the question that doesn't have an answer anywhere right now.

## The killer join

The four datasets exist independently. USDA PLANTS gives you native-or-not at the county level. USDA Plant Hardiness Zones tell you what survives the winter. Xerces Society and similar regional sources tell you which plants matter to pollinators. State extension services and regional native plant societies have the bloom calendars and growing conditions.

Nobody has joined them. That join — done once, kept current — is the entire product. Everything else is interface and infrastructure.

## Who would use it

Gardeners who want their yard to do ecological work, not just look pretty. Landscape designers and nurseries who'd rather query a clean source than maintain a spreadsheet. Municipal parks departments and DOTs designing roadside seed mixes. Conservation NGOs running habitat-restoration cost-share programs. School gardens and university campus grounds. AI gardening assistants that need grounded answers about what's native to a specific place. Citizen science apps that want to surface "did you know this plant supports forty-seven species of caterpillar?" alongside an iNaturalist observation. Real estate listings, increasingly, advertising pollinator-friendly landscaping.

And — quietly important — researchers studying ecological change. The same dataset that answers "what should I plant" can answer "what *was* native here in 1985 versus today" if it's archived properly. That second question is going to get a lot more interesting over the next twenty years.

## What it unblocks

A "scan your yard with your phone, get a native-plant restoration plan" app. A garden-center kiosk that prints a personalized native plant list based on your address. A landscape architect's design tool that flags "you specified a Japanese maple here; here are three native alternatives that fit the same niche." Municipal grant applications generated automatically. School curricula that teach kids the plants and pollinators specific to their schoolyard. The rewilding movement currently has activists, books, and TED talks but no shared software substrate; this is the substrate.

## Why now

Native plant gardening is having its moment. Pollinator decline has reached general-public awareness. State and federal funding for native landscapes is at a high — the Inflation Reduction Act included money for native-plant habitat work, several states have launched native-plant rebate programs, the USDA's Conservation Reserve Program is funding pollinator habitat at scale. Nurseries are scrambling to expand native inventory. Every climate-conscious millennial who buys a house this year is going to ask exactly this question.

There is also a specific window of opportunity: the data sources that need to be joined are mostly stable and public. USDA PLANTS isn't going anywhere. The Xerces Society lists are slow to change. The hardiness zone map updates roughly once a decade. This is unusually stable infrastructure to build on — most "wrap government data" projects have shifting ground under them, and this one doesn't.

## The honest case against

Bloom periods and habitat preferences are regionally variable in ways the source data sometimes papers over. A plant that blooms in May in Virginia might bloom in late June in Montana. The dataset has to communicate that variance instead of pretending one number applies everywhere.

"Native" is also a contested concept at the edges. Native to North America? Native to the ecoregion? Native to the specific watershed? Pre-European-contact range or current range? Reasonable people disagree, and the dataset has to make a defensible choice and document it.

Pollinator-value data is uneven. Some plants are very well-studied — milkweed and monarchs, oaks and caterpillars. Others have one or two papers and a lot of folklore. The dataset needs honest confidence ratings.

And the user base, while broader than the hydroponics one, is still niche-of-niches in the broader app ecosystem. This is a project that will get a lot of quiet love from a few thousand people and never trend on social media. The reward is being the thing that quietly powers a generation of small ecological apps.
