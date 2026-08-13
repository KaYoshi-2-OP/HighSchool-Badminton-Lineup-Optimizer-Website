# Configurable League Formats

The website supports a separate meet format for each season. Before importing
results for a season, enter the number of events in each category:

- Boys Singles (BS)
- Girls Singles (GS)
- Boys Doubles (BD)
- Girls Doubles (GD)
- Mixed Doubles (XD)

The standard format remains `4 BS + 4 GS + 3 BD + 3 GD + 3 XD = 17` events.
Accounts and seasons without a saved setting continue to use that format.

## What changes with the format

The saved counts determine:

- the numbered positions generated for the season;
- the exact rows accepted in match imports and result entry;
- the number of boys and girls required in a legal lineup;
- the number of event assignments considered by the optimizer;
- the projected meet score; and
- the strict-majority threshold for an outright meet win.

For counts \(BS, GS, BD, GD, XD\), the roster requirements are:

```text
required boys  = BS + 2(BD) + XD
required girls = GS + 2(GD) + XD
```

If a meet contains \(M\) events, an outright win requires:

```text
floor(M / 2) + 1 wins
```

An even number of events is allowed, but the meet can end in a tie.

## What does not change

The preseason initialization curve, Elo win probability, home-player update,
point-differential observation, rolling ten-season weighting, doubles rating,
and historical calibration formulas are unchanged. The format only changes the
event set and the legal lineup combinations searched.

The optimizer uses 120 search starts for the standard 17-event format. For a
larger meet it adds 20 starts per event above 17, up to 600 starts:

```text
search starts = min(600, 120 + 20 * max(0, M - 17))
```

This is a computational search-budget rule, not a rating formula.

## Data protection rule

Once results have been stored for a season, its event format is locked. This
prevents old match rows from becoming inconsistent with a newly edited format.
To use a nonstandard historical format, save that season's five counts before
importing its results.

## Research-paper scope

The research paper may evaluate only the fixed 17-event format. The website's
configurable-format feature can be described as a software extension or future
generalization for leagues with different meet structures.
