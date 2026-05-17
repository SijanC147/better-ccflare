import type { Project, WorktreeRule, WorktreeRuleKind } from "@better-ccflare/types";
import {
	AlertCircle,
	ChevronDown,
	ChevronRight,
	FolderOpen,
	GitBranch,
	Pencil,
	Plus,
	RefreshCw,
	Trash2,
	X,
} from "lucide-react";
import { useState } from "react";
import {
	useCreateProject,
	useCreateWorktreeRule,
	useDeleteProject,
	useDeleteWorktreeRule,
	useDiscoverProjects,
	useProjectsAll,
	useUpdateProject,
	useUpdateWorktreeRule,
	useWorktreeRules,
} from "../hooks/queries";
import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Switch } from "./ui/switch";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function relativeTime(ms: number | null): string {
	if (ms == null) return "never";
	const diff = Date.now() - ms;
	const mins = Math.floor(diff / 60_000);
	if (mins < 1) return "just now";
	if (mins < 60) return `${mins}m ago`;
	const hrs = Math.floor(mins / 60);
	if (hrs < 24) return `${hrs}h ago`;
	const days = Math.floor(hrs / 24);
	return `${days}d ago`;
}

// ---------------------------------------------------------------------------
// Add/Edit Project Dialog
// ---------------------------------------------------------------------------

interface ProjectDialogProps {
	open: boolean;
	onClose: () => void;
	project?: Project | null;
	allProjects: Project[];
}

function ProjectDialog({ open, onClose, project, allProjects }: ProjectDialogProps) {
	const isEdit = !!project;
	const createProject = useCreateProject();
	const updateProject = useUpdateProject();

	const [canonicalPath, setCanonicalPath] = useState(project?.canonical_path ?? "");
	const [displayName, setDisplayName] = useState(project?.display_name ?? "");
	const [parentId, setParentId] = useState<string>(project?.parent_project_id ?? "__none__");
	const [error, setError] = useState<string | null>(null);

	const busy = createProject.isPending || updateProject.isPending;

	const handleSubmit = async () => {
		setError(null);
		try {
			if (isEdit && project) {
				await updateProject.mutateAsync({
					id: project.id,
					body: {
						display_name: displayName.trim() || undefined,
						parent_project_id: parentId === "__none__" ? null : parentId,
					},
				});
			} else {
				if (!canonicalPath.trim()) {
					setError("Canonical path is required.");
					return;
				}
				await createProject.mutateAsync({
					canonical_path: canonicalPath.trim(),
					display_name: displayName.trim() || undefined,
					parent_project_id: parentId === "__none__" ? null : parentId,
				});
			}
			onClose();
		} catch (e) {
			setError(e instanceof Error ? e.message : "Unknown error");
		}
	};

	const parentCandidates = allProjects.filter(
		(p) => !isEdit || p.id !== project?.id,
	);

	return (
		<Dialog open={open} onOpenChange={(v) => !v && onClose()}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>{isEdit ? "Edit Project" : "Add Manual Project"}</DialogTitle>
				</DialogHeader>
				<div className="space-y-4 py-2">
					{!isEdit && (
						<div className="space-y-1">
							<Label htmlFor="canonical_path">Canonical Path</Label>
							<Input
								id="canonical_path"
								placeholder="/Users/you/Code/my-project"
								value={canonicalPath}
								onChange={(e) => setCanonicalPath(e.target.value)}
							/>
						</div>
					)}
					<div className="space-y-1">
						<Label htmlFor="display_name">Display Name</Label>
						<Input
							id="display_name"
							placeholder="Optional — defaults to folder name"
							value={displayName}
							onChange={(e) => setDisplayName(e.target.value)}
						/>
					</div>
					<div className="space-y-1">
						<Label htmlFor="parent">Parent Project</Label>
						<Select value={parentId} onValueChange={setParentId}>
							<SelectTrigger id="parent">
								<SelectValue placeholder="None (top-level)" />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="__none__">None (top-level)</SelectItem>
								{parentCandidates.map((p) => (
									<SelectItem key={p.id} value={p.id}>
										{p.display_name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
					{error && (
						<p className="text-sm text-destructive">{error}</p>
					)}
				</div>
				<DialogFooter>
					<Button variant="ghost" onClick={onClose} disabled={busy}>
						Cancel
					</Button>
					<Button onClick={handleSubmit} disabled={busy}>
						{busy ? "Saving…" : isEdit ? "Save" : "Add"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

// ---------------------------------------------------------------------------
// Worktree Rule Dialog
// ---------------------------------------------------------------------------

interface RuleDialogProps {
	open: boolean;
	onClose: () => void;
	rule?: WorktreeRule | null;
	allProjects: Project[];
}

function WorktreeRuleDialog({ open, onClose, rule, allProjects }: RuleDialogProps) {
	const isEdit = !!rule;
	const createRule = useCreateWorktreeRule();
	const updateRule = useUpdateWorktreeRule();

	const [kind, setKind] = useState<WorktreeRuleKind>(rule?.kind ?? "glob");
	const [pattern, setPattern] = useState(rule?.pattern ?? "");
	const [parentId, setParentId] = useState<string>(rule?.parent_project_id ?? "__none__");
	const [priority, setPriority] = useState(String(rule?.priority ?? 0));
	const [samplePaths, setSamplePaths] = useState("");
	const [testResults, setTestResults] = useState<Array<{ path: string; matched: boolean; error?: string }> | null>(null);
	const [error, setError] = useState<string | null>(null);

	const busy = createRule.isPending || updateRule.isPending;

	const handleTest = async () => {
		setError(null);
		setTestResults(null);
		const paths = samplePaths.split("\n").map((s) => s.trim()).filter(Boolean);
		if (paths.length === 0) {
			setError("Enter at least one sample path.");
			return;
		}
		try {
			const res = await fetch("/api/worktree-rules/test", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ kind, pattern, samplePaths: paths }),
			});
			const data = await res.json();
			if (data.success) {
				setTestResults(data.matches);
			} else {
				setError(data.error ?? "Test failed");
			}
		} catch (e) {
			setError(e instanceof Error ? e.message : "Test failed");
		}
	};

	const handleSubmit = async () => {
		setError(null);
		if (!pattern.trim()) {
			setError("Pattern is required.");
			return;
		}
		try {
			const body = {
				kind,
				pattern: pattern.trim(),
				parent_project_id: parentId === "__none__" ? null : parentId,
				priority: Number(priority) || 0,
			};
			if (isEdit && rule) {
				await updateRule.mutateAsync({ id: rule.id, body });
			} else {
				await createRule.mutateAsync(body);
			}
			onClose();
		} catch (e) {
			setError(e instanceof Error ? e.message : "Unknown error");
		}
	};

	return (
		<Dialog open={open} onOpenChange={(v) => !v && onClose()}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>{isEdit ? "Edit Worktree Rule" : "Add Worktree Rule"}</DialogTitle>
				</DialogHeader>
				<div className="space-y-4 py-2">
					<div className="grid grid-cols-2 gap-4">
						<div className="space-y-1">
							<Label>Kind</Label>
							<Select value={kind} onValueChange={(v) => setKind(v as WorktreeRuleKind)}>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="glob">Glob</SelectItem>
									<SelectItem value="regex">Regex</SelectItem>
									<SelectItem value="directory">Directory</SelectItem>
								</SelectContent>
							</Select>
						</div>
						<div className="space-y-1">
							<Label htmlFor="priority">Priority</Label>
							<Input
								id="priority"
								type="number"
								value={priority}
								onChange={(e) => setPriority(e.target.value)}
							/>
						</div>
					</div>
					<div className="space-y-1">
						<Label htmlFor="pattern">Pattern</Label>
						<Input
							id="pattern"
							placeholder={kind === "glob" ? "**/.worktrees/**" : kind === "regex" ? "\\.worktrees/" : "/path/to/worktrees"}
							value={pattern}
							onChange={(e) => setPattern(e.target.value)}
						/>
					</div>
					<div className="space-y-1">
						<Label>Parent Project (optional)</Label>
						<Select value={parentId} onValueChange={setParentId}>
							<SelectTrigger>
								<SelectValue placeholder="Inferred from longest-prefix match" />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="__none__">Infer from project path</SelectItem>
								{allProjects.map((p) => (
									<SelectItem key={p.id} value={p.id}>
										{p.display_name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
					<div className="space-y-1">
						<Label htmlFor="sample_paths">Test Against Sample Paths</Label>
						<textarea
							id="sample_paths"
							className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono resize-y min-h-[80px]"
							placeholder="/Users/you/Code/my-project/.worktrees/fix-branch"
							value={samplePaths}
							onChange={(e) => setSamplePaths(e.target.value)}
						/>
						<Button variant="outline" size="sm" onClick={handleTest} type="button">
							Test Rule
						</Button>
					</div>
					{testResults && (
						<div className="rounded-md border bg-muted/50 p-3 space-y-1 text-xs font-mono">
							{testResults.map((r) => (
								<div key={r.path} className={cn("flex gap-2", r.matched ? "text-green-600" : "text-muted-foreground")}>
									<span>{r.matched ? "✓" : "✗"}</span>
									<span className="truncate">{r.path}</span>
									{r.error && <span className="text-destructive">{r.error}</span>}
								</div>
							))}
						</div>
					)}
					{error && <p className="text-sm text-destructive">{error}</p>}
				</div>
				<DialogFooter>
					<Button variant="ghost" onClick={onClose} disabled={busy}>
						Cancel
					</Button>
					<Button onClick={handleSubmit} disabled={busy}>
						{busy ? "Saving…" : isEdit ? "Save" : "Add Rule"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

// ---------------------------------------------------------------------------
// ProjectRow — renders one project with optional child worktrees nested
// ---------------------------------------------------------------------------

interface ProjectRowProps {
	project: Project;
	children: Project[];
	allProjects: Project[];
	onEdit: (p: Project) => void;
	onDelete: (p: Project) => void;
}

function ProjectRow({ project, children, allProjects, onEdit, onDelete }: ProjectRowProps) {
	const [expanded, setExpanded] = useState(true);
	const updateProject = useUpdateProject();

	const handleToggleEnabled = () => {
		updateProject.mutate({ id: project.id, body: { enabled: !project.enabled } });
	};

	const isWorktree = project.parent_project_id !== null;

	return (
		<div className={cn("border rounded-lg", isWorktree && "ml-6 border-dashed")}>
			<div className="flex items-center gap-3 p-3">
				{children.length > 0 && (
					<button
						type="button"
						className="text-muted-foreground hover:text-foreground"
						onClick={() => setExpanded((e) => !e)}
					>
						{expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
					</button>
				)}
				{children.length === 0 && <div className="w-4" />}

				<FolderOpen className={cn("h-4 w-4 shrink-0", project.enabled ? "text-primary" : "text-muted-foreground")} />

				<div className="flex-1 min-w-0">
					<div className="flex items-center gap-2 flex-wrap">
						<span className={cn("font-medium text-sm truncate", !project.enabled && "text-muted-foreground line-through")}>
							{project.display_name}
						</span>
						{project.source === "manual" && (
							<Badge variant="outline" className="text-xs">manual</Badge>
						)}
						{isWorktree && (
							<Badge variant="secondary" className="text-xs gap-1">
								<GitBranch className="h-3 w-3" />
								worktree
							</Badge>
						)}
					</div>
					<p className="text-xs text-muted-foreground truncate font-mono">{project.canonical_path}</p>
					<p className="text-xs text-muted-foreground">
						{project.session_count} session{project.session_count !== 1 ? "s" : ""} · last active {relativeTime(project.last_session_at)}
					</p>
				</div>

				<div className="flex items-center gap-2 shrink-0">
					<Switch
						checked={project.enabled}
						onCheckedChange={handleToggleEnabled}
						title={project.enabled ? "Disable project" : "Enable project"}
					/>
					<Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => onEdit(project)} title="Edit">
						<Pencil className="h-3.5 w-3.5" />
					</Button>
					{project.source === "manual" && (
						<Button
							variant="ghost"
							size="icon"
							className="h-7 w-7 text-destructive hover:text-destructive"
							onClick={() => onDelete(project)}
							title="Delete"
						>
							<Trash2 className="h-3.5 w-3.5" />
						</Button>
					)}
				</div>
			</div>

			{expanded && children.length > 0 && (
				<div className="px-3 pb-3 space-y-2">
					{children.map((child) => (
						<ProjectRow
							key={child.id}
							project={child}
							children={[]}
							allProjects={allProjects}
							onEdit={onEdit}
							onDelete={onDelete}
						/>
					))}
				</div>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Worktree Rule Row
// ---------------------------------------------------------------------------

interface RuleRowProps {
	rule: WorktreeRule;
	allProjects: Project[];
	onEdit: (r: WorktreeRule) => void;
	onDelete: (r: WorktreeRule) => void;
}

function WorktreeRuleRow({ rule, allProjects, onEdit, onDelete }: RuleRowProps) {
	const updateRule = useUpdateWorktreeRule();
	const parentProject = allProjects.find((p) => p.id === rule.parent_project_id);

	return (
		<div className="flex items-center gap-3 p-3 border rounded-lg">
			<div className="flex-1 min-w-0">
				<div className="flex items-center gap-2 flex-wrap">
					<Badge variant="outline" className="text-xs font-mono">{rule.kind}</Badge>
					<code className="text-xs bg-muted px-1 py-0.5 rounded truncate max-w-[300px]">{rule.pattern}</code>
					{rule.compile_error && (
						<Badge variant="destructive" className="text-xs gap-1">
							<AlertCircle className="h-3 w-3" />
							compile error
						</Badge>
					)}
				</div>
				<p className="text-xs text-muted-foreground mt-0.5">
					Priority {rule.priority}
					{parentProject ? ` · parent: ${parentProject.display_name}` : " · parent: inferred"}
				</p>
			</div>
			<div className="flex items-center gap-2 shrink-0">
				<Switch
					checked={rule.enabled}
					onCheckedChange={() => updateRule.mutate({ id: rule.id, body: { enabled: !rule.enabled } })}
				/>
				<Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => onEdit(rule)} title="Edit">
					<Pencil className="h-3.5 w-3.5" />
				</Button>
				<Button
					variant="ghost"
					size="icon"
					className="h-7 w-7 text-destructive hover:text-destructive"
					onClick={() => onDelete(rule)}
					title="Delete"
				>
					<Trash2 className="h-3.5 w-3.5" />
				</Button>
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// ProjectsTab (root)
// ---------------------------------------------------------------------------

export function ProjectsTab() {
	const { data: projects = [], isLoading: projectsLoading, error: projectsError } = useProjectsAll();
	const { data: rules = [], isLoading: rulesLoading } = useWorktreeRules();
	const discoverProjects = useDiscoverProjects();
	const deleteProject = useDeleteProject();
	const deleteWorktreeRule = useDeleteWorktreeRule();

	const [search, setSearch] = useState("");
	const [projectDialog, setProjectDialog] = useState<{ open: boolean; project?: Project | null }>({ open: false });
	const [ruleDialog, setRuleDialog] = useState<{ open: boolean; rule?: WorktreeRule | null }>({ open: false });
	const [discoverResult, setDiscoverResult] = useState<string | null>(null);

	const handleDiscover = async () => {
		setDiscoverResult(null);
		try {
			const result = await discoverProjects.mutateAsync();
			if (result) {
				setDiscoverResult(`Scan complete — added: ${result.added}, updated: ${result.updated}, unchanged: ${result.unchanged}`);
			}
		} catch {
			setDiscoverResult("Scan failed — check server logs.");
		}
	};

	const handleDeleteProject = (project: Project) => {
		if (confirm(`Delete project "${project.display_name}"? This cannot be undone.`)) {
			deleteProject.mutate(project.id);
		}
	};

	const handleDeleteRule = (rule: WorktreeRule) => {
		if (confirm(`Delete worktree rule "${rule.pattern}"?`)) {
			deleteWorktreeRule.mutate(rule.id);
		}
	};

	// Build tree: top-level projects + their children
	const filteredProjects = projects.filter((p) => {
		if (!search) return true;
		const q = search.toLowerCase();
		return p.display_name.toLowerCase().includes(q) || p.canonical_path.toLowerCase().includes(q);
	});

	// Map parent_id → children
	const childrenMap = new Map<string, Project[]>();
	for (const p of filteredProjects) {
		if (p.parent_project_id) {
			const existing = childrenMap.get(p.parent_project_id) ?? [];
			existing.push(p);
			childrenMap.set(p.parent_project_id, existing);
		}
	}
	const topLevel = filteredProjects.filter((p) => !p.parent_project_id);

	return (
		<div className="space-y-6 p-6">
			{/* Header */}
			<div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center">
				<div className="flex-1">
					<Input
						placeholder="Search projects…"
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						className="max-w-sm"
					/>
				</div>
				<div className="flex gap-2 shrink-0">
					<Button
						variant="outline"
						size="sm"
						onClick={handleDiscover}
						disabled={discoverProjects.isPending}
					>
						<RefreshCw className={cn("h-4 w-4 mr-2", discoverProjects.isPending && "animate-spin")} />
						{discoverProjects.isPending ? "Scanning…" : "Discover"}
					</Button>
					<Button
						size="sm"
						onClick={() => setProjectDialog({ open: true, project: null })}
					>
						<Plus className="h-4 w-4 mr-2" />
						Add Project
					</Button>
				</div>
			</div>

			{discoverResult && (
				<div className="flex items-center gap-2 text-sm text-muted-foreground bg-muted/50 rounded-md px-3 py-2">
					<span>{discoverResult}</span>
					<button type="button" onClick={() => setDiscoverResult(null)} className="ml-auto">
						<X className="h-4 w-4" />
					</button>
				</div>
			)}

			{/* Projects list */}
			<Card>
				<CardHeader className="pb-3">
					<CardTitle className="text-base flex items-center gap-2">
						<FolderOpen className="h-4 w-4" />
						Projects
						{!projectsLoading && (
							<Badge variant="secondary" className="text-xs">{projects.length}</Badge>
						)}
					</CardTitle>
				</CardHeader>
				<CardContent className="space-y-2">
					{projectsLoading && (
						<p className="text-sm text-muted-foreground">Loading…</p>
					)}
					{projectsError && (
						<p className="text-sm text-destructive">Failed to load projects.</p>
					)}
					{!projectsLoading && topLevel.length === 0 && (
						<p className="text-sm text-muted-foreground">
							{search ? "No projects match your search." : "No projects found. Click Discover to scan ~/.claude/projects/."}
						</p>
					)}
					{topLevel.map((project) => (
						<ProjectRow
							key={project.id}
							project={project}
							children={childrenMap.get(project.id) ?? []}
							allProjects={projects}
							onEdit={(p) => setProjectDialog({ open: true, project: p })}
							onDelete={handleDeleteProject}
						/>
					))}
				</CardContent>
			</Card>

			{/* Worktree rules */}
			<Card>
				<CardHeader className="pb-3">
					<div className="flex items-center justify-between">
						<CardTitle className="text-base flex items-center gap-2">
							<GitBranch className="h-4 w-4" />
							Worktree Rules
							{!rulesLoading && (
								<Badge variant="secondary" className="text-xs">{rules.length}</Badge>
							)}
						</CardTitle>
						<Button
							size="sm"
							variant="outline"
							onClick={() => setRuleDialog({ open: true, rule: null })}
						>
							<Plus className="h-4 w-4 mr-2" />
							Add Rule
						</Button>
					</div>
				</CardHeader>
				<CardContent className="space-y-2">
					{rulesLoading && (
						<p className="text-sm text-muted-foreground">Loading…</p>
					)}
					{!rulesLoading && rules.length === 0 && (
						<p className="text-sm text-muted-foreground">
							No worktree rules yet. Add a glob, regex, or directory rule to mark paths as worktrees.
						</p>
					)}
					{rules.map((rule) => (
						<WorktreeRuleRow
							key={rule.id}
							rule={rule}
							allProjects={projects}
							onEdit={(r) => setRuleDialog({ open: true, rule: r })}
							onDelete={handleDeleteRule}
						/>
					))}
				</CardContent>
			</Card>

			{/* Dialogs */}
			<ProjectDialog
				open={projectDialog.open}
				project={projectDialog.project}
				allProjects={projects}
				onClose={() => setProjectDialog({ open: false })}
			/>
			<WorktreeRuleDialog
				open={ruleDialog.open}
				rule={ruleDialog.rule}
				allProjects={projects}
				onClose={() => setRuleDialog({ open: false })}
			/>
		</div>
	);
}
