"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { Check, ChevronsUpDown, X } from "lucide-react";

import {
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@repo/ui";

import {
  createProjectSchema,
  type CreateProjectInput,
} from "@/lib/validations/project";

interface CreateProjectFormProps {
  onSuccess?: () => void;
}

/**
 * Temporary static users.
 *
 * Later this will come from your users/search API.
 */
const availableMembers = [
  {
    id: "user-1",
    name: "Aman Sharma",
    email: "aman@example.com",
  },
  {
    id: "user-2",
    name: "Rahul Verma",
    email: "rahul@example.com",
  },
  {
    id: "user-3",
    name: "Priya Singh",
    email: "priya@example.com",
  },
  {
    id: "user-4",
    name: "Ankit Kumar",
    email: "ankit@example.com",
  },
  {
    id: "user-5",
    name: "Neha Gupta",
    email: "neha@example.com",
  },
];

export function CreateProjectForm({
  onSuccess,
}: CreateProjectFormProps) {
  const router = useRouter();

  const [serverError, setServerError] =
    React.useState<string | null>(null);

  const [membersOpen, setMembersOpen] =
    React.useState(false);

  const form = useForm<CreateProjectInput>({
    resolver: zodResolver(createProjectSchema),
    defaultValues: {
      name: "",
      description: "",
      template: "NEXTJS",
      memberIds: [],
    },
  });

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors, isSubmitting },
  } = form;

  const template = watch("template");
  const memberIds = watch("memberIds") ?? [];

  function toggleMember(memberId: string) {
    const currentMembers = memberIds ?? [];

    const isSelected =
      currentMembers.includes(memberId);

    const updatedMembers = isSelected
      ? currentMembers.filter((id) => id !== memberId)
      : [...currentMembers, memberId];

    setValue("memberIds", updatedMembers, {
      shouldValidate: true,
      shouldDirty: true,
    });
  }

  function removeMember(memberId: string) {
    setValue(
      "memberIds",
      memberIds.filter((id) => id !== memberId),
      {
        shouldValidate: true,
        shouldDirty: true,
      }
    );
  }

  async function onSubmit(data: CreateProjectInput) {
    setServerError(null);

    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(data),
      });

      const result = await response.json();

      if (!response.ok) {
        setServerError(
          result.error ?? "Failed to create project."
        );

        return;
      }

      onSuccess?.();

      router.push(
        `/dashboard/projects/${result.project.id}`
      );

      router.refresh();
    } catch {
      setServerError(
        "Something went wrong. Please try again."
      );
    }
  }

  return (
    <form
      onSubmit={handleSubmit(onSubmit)}
      className="mt-8 space-y-6"
    >
      {/* Project Name */}
      <div className="space-y-2">
        <Label htmlFor="name">
          Project name
        </Label>

        <Input
          id="name"
          placeholder="My awesome project"
          {...register("name")}
        />

        {errors.name && (
          <p className="text-sm text-destructive">
            {errors.name.message}
          </p>
        )}
      </div>

      {/* Description */}
      <div className="space-y-2">
        <Label htmlFor="description">
          Description
        </Label>

        <Textarea
          id="description"
          placeholder="What are you building?"
          rows={4}
          {...register("description")}
        />

        {errors.description && (
          <p className="text-sm text-destructive">
            {errors.description.message}
          </p>
        )}
      </div>

      {/* Template */}
      <div className="space-y-2">
        <Label htmlFor="template">
          Template
        </Label>

        <Select
          value={template}
          onValueChange={(value) =>
            setValue(
              "template",
              value as CreateProjectInput["template"],
              {
                shouldValidate: true,
              }
            )
          }
        >
          <SelectTrigger id="template">
            <SelectValue placeholder="Select a template" />
          </SelectTrigger>

          <SelectContent>
            <SelectItem value="NEXTJS">
              Next.js
            </SelectItem>

            <SelectItem value="REACT">
              React
            </SelectItem>

            <SelectItem value="VUE">
              Vue
            </SelectItem>

            <SelectItem value="HONO">
              Hono
            </SelectItem>

            <SelectItem value="EXPRESS">
              Express
            </SelectItem>

            <SelectItem value="ANGULAR">
              Angular
            </SelectItem>
          </SelectContent>
        </Select>

        {errors.template && (
          <p className="text-sm text-destructive">
            {errors.template.message}
          </p>
        )}
      </div>

      {/* Members */}
      <div className="space-y-2">
        <Label>Members</Label>

        <Popover
          open={membersOpen}
          onOpenChange={setMembersOpen}
        >
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="outline"
              role="combobox"
              aria-expanded={membersOpen}
              className="w-full justify-between font-normal"
            >
              {memberIds.length > 0
                ? `${memberIds.length} member${
                    memberIds.length === 1 ? "" : "s"
                  } selected`
                : "Add project members"}

              <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
            </Button>
          </PopoverTrigger>

          <PopoverContent
            align="start"
            className="w-[var(--radix-popover-trigger-width)] p-0"
          >
            <Command>
              <CommandInput placeholder="Search members..." />

              <CommandList>
                <CommandEmpty>
                  No members found.
                </CommandEmpty>

                <CommandGroup heading="Members">
                  {availableMembers.map((member) => {
                    const selected =
                      memberIds.includes(member.id);

                    return (
                      <CommandItem
                        key={member.id}
                        value={`${member.name} ${member.email}`}
                        onSelect={() =>
                          toggleMember(member.id)
                        }
                      >
                        <div className="flex min-w-0 flex-1 flex-col">
                          <span className="text-sm">
                            {member.name}
                          </span>

                          <span className="truncate text-xs text-muted-foreground">
                            {member.email}
                          </span>
                        </div>

                        <Check
                          className={`ml-auto size-4 ${
                            selected
                              ? "opacity-100"
                              : "opacity-0"
                          }`}
                        />
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>

        {/* Selected members */}
        {memberIds.length > 0 && (
          <div className="flex flex-wrap gap-2 pt-1">
            {memberIds.map((memberId) => {
              const member =
                availableMembers.find(
                  (item) => item.id === memberId
                );

              if (!member) return null;

              return (
                <div
                  key={member.id}
                  className="flex items-center gap-1 rounded-md border bg-muted px-2 py-1 text-xs"
                >
                  <span>{member.name}</span>

                  <button
                    type="button"
                    onClick={() =>
                      removeMember(member.id)
                    }
                    className="ml-1 rounded-sm opacity-60 hover:opacity-100"
                    aria-label={`Remove ${member.name}`}
                  >
                    <X className="size-3" />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        <p className="text-xs text-muted-foreground">
          You can add members after creating the project as
          well.
        </p>
      </div>

      {/* Server Error */}
      {serverError && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          {serverError}
        </div>
      )}

      {/* Submit */}
      <Button
        type="submit"
        className="w-full"
        disabled={isSubmitting}
      >
        {isSubmitting
          ? "Creating project..."
          : "Create project"}
      </Button>
    </form>
  );
}