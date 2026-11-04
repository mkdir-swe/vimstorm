# Release gate · sweep (tester C, fakes)

Tester C runs alongside A and B on a rig env (`qarig up gate-C`, fakes only): the 3.0 surfaces that
need no box, each with a film the coordinator reads with `qarig diff`. Same rules as
`demo-shop.md`: keys from the release commit, `judge` rows by the tester agent, zero hand fixes.

## C1 · Find your way

`:` asks first and types every letter (#346); the Welcome is the Board (#212).

```gate
wait Factory in view within 30s
film C1-colon 20 100 {@:}{type:pro}
wait 'Prototype' in layer within 5s
do {@escape}
see C1 main layer status
judge the films/C1-colon frames show the `:` menu filtering on each letter, no jump
```

## C2 · Errors clear themselves

The fake board goes away and comes back; the error shows, then goes with no key pressed (#348).

```gate
snap C2-before
scenario board-down
wait 'Azure DevOps' in balloons within 60s
snap C2-down
scenario reseed
wait 'Azure DevOps' in balloons gone within 2m
see C2 main status balloons
snap C2-after
```

## C3 · Linked opens at once

A story's Linked shows with no wait (#341).

```gate
do {@super+3}{wait:500}{@:}{type:card {card:4}}{@enter}
film C3-linked 15 100 {@super+enter}{type:Linked}{@enter}
wait Linked in main within 2s
judge films/C3-linked shows Linked's rows on its first frames, no empty state between
```

## C4 · Settings walk and one theme switch

Settings opens, its sections walk, one theme switch repaints (#345).

```gate
film C4-settings 40 150 {@super+,}{wait:300}{@ö}{@ö}{@ö}{@ö}{wait:300}{type:/theme}{@enter}
snap C4-theme
do {@escape}{@escape}
judge films/C4-settings walks the sections with no flicker and C4-theme shows the switched theme
```

## C5 · Story comments and images

A story's comments and images show (#238).

```gate
do {@super+3}{wait:500}{@:}{type:card {card:4}}{@enter}
wait 'magic links' within 10s
snap C5
see C5 main
```

## C6 · Close-out

```gate
down
```
