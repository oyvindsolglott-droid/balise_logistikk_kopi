# SDE private handwriting learning

The browser performs all recognition locally before Save. No pixels, crops,
suggestions or form values are persisted before the user explicitly saves a
human-controlled form.

An authorized Save atomically stores the original image, the final canonical
form, cell geometry, raw candidates, dispositions and human ground truth in
private server storage outside the public webroot. `scripts/sde_handwriting_learning.py`
then provides four deliberately separate operator steps:

1. `prepare` creates original and processed private cell crops and train-only
   augmentations. Its split manifest assigns whole documents to private train,
   validation or blind holdout.
2. `train` invokes an explicit local trainer argv and produces a candidate
   manifest. It never activates the candidate.
3. `qualify` applies the fail-closed 99% precision, 85% clear-cell coverage,
   10% correction-rate, leakage, blank, gibberish and row/column gates.
4. `promote` requires an exact human-approved candidate SHA; `rollback`
   restores the previously active hash.

Private manifests, images, crops, labels and model candidates must live outside
the repository and must never be attached to public CI artifacts.
