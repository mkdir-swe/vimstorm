# Gate · parallel testers (fakes)

Two or more testers run this whole at the same time, each on its own rig env and live app
(`qarig up p-A`, `qarig up p-B --seed-offset 100`, `qarig live <env> --abe`; fakes only), then a
third runs it alone. Pass: every row PASS in each run, the parallel runs' RESULT.md tables match the
lone run's step for step (ms aside), and no env's trees or drive.log show the other's card numbers
(`{card:4}` is seed card 4 on the env's own board: 4 for A, 104 for B). It is the check that the
drive socket keeps testers apart (docs/agents/in-app-qa.md); keys are the app's own.

## P1 · The Board shows this env's card

```gate
wait factory in view within 30s
wait 'card={card:4}' in main within 60s
see P1 view main
```

## P2 · A card opens and closes

```gate
do {@enter}
wait CardDialog in layer within 10s
wait 'card={card:4}' in layer within 5s
see P2 layer
do {@escape}
wait CardDialog in layer gone within 5s
```

## P3 · Settings opens, walks, closes

```gate
do {@super+,}
wait SettingsDialog in layer within 10s
film P3-walk 10 100 {@ö}{@ö}{@ö}
see P3 layer
do {@escape}
wait SettingsDialog in layer gone within 5s
```

## P4 · Editor and back

```gate
do {@super+alt+a}
wait editor in view within 10s
do {@super+alt+a}
wait factory in view within 10s
snap P4
```

## P5 · Close-out

```gate
down
```
